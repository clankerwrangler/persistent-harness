import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_SUPPORT_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "python-runtime");
const UV_VERSION = "0.12.3";
const UV_ARCHIVE = "uv-x86_64-unknown-linux-gnu.tar.gz";
const UV_SHA256 = "600cf9a742aca00d292673b16b5acffaa7b8c269a364ad0c2e79498dcb1fe101";
const PYTHON_VERSION = "3.12.12";
const IPYTHON_VERSION = "9.10.0";
const DILL_VERSION = "0.3.8";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, { cwd, env, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onProgress?.(text.trim());
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onProgress?.(text.trim());
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited code=${code} signal=${signal}\n${stderr || stdout}`));
    });
  });
}

async function download(url, target, expectedHash) {
  const response = await fetch(url, { headers: { "user-agent": "persistent-harness" }, redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = hash(bytes);
  if (actual !== expectedHash) throw new Error(`download checksum mismatch: expected ${expectedHash}, received ${actual}`);
  await writeFile(target, bytes, { mode: 0o600 });
}

async function validatePython(pythonPath, skills = []) {
  const sourcePaths = skills.flatMap((skill) => skill.python ? [skill.python.srcPath] : []);
  const imports = skills.flatMap((skill) => skill.python ? [skill.python.importName] : []);
  const probeCode = [
    "import IPython,dill,importlib,sys",
    ...imports.map((name) => `importlib.import_module(${JSON.stringify(name)})`),
    "print(sys.version.split()[0], IPython.__version__, dill.__version__)",
  ].join(";");
  const probe = await run(pythonPath, ["-c", probeCode], {
    env: {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: [RUNTIME_SUPPORT_DIR, ...sourcePaths, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  });
  const [python, ipython, dill] = probe.stdout.trim().split(/\s+/);
  if (!python || !ipython || !dill) throw new Error(`invalid Python runtime probe: ${probe.stdout}`);
  return { python, ipython, dill };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireInstallLock(lockPath, timeoutMs = 180_000) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const content = `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await writeFile(lockPath, content, { mode: 0o600, flag: "wx" });
      return async () => {
        try {
          if (await readFile(lockPath, "utf8") === content) await unlink(lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ownerContent = await readFile(lockPath, "utf8");
        const owner = JSON.parse(ownerContent);
        if (!processIsAlive(owner.pid) && await readFile(lockPath, "utf8") === ownerContent) await unlink(lockPath);
      } catch (ownerError) {
        if (ownerError?.code !== "ENOENT") {
          try {
            const lockStat = await stat(lockPath);
            if (Date.now() - lockStat.mtimeMs > 5000) await unlink(lockPath);
          } catch {}
        }
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Python runtime lock ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function assertManagedVersions(versions) {
  if (versions.python !== PYTHON_VERSION || versions.ipython !== IPYTHON_VERSION || versions.dill !== DILL_VERSION) {
    throw new Error(`managed runtime version mismatch: ${JSON.stringify(versions)}`);
  }
}

export class PythonRuntimeManager {
  #ensurePromise;

  constructor({ runtimeDir, pythonOverride = process.env.PI_HARNESS_PYTHON }) {
    this.runtimeDir = runtimeDir;
    this.pythonOverride = pythonOverride;
  }

  async ensure({ skills, consent, onProgress = () => {} }) {
    if (this.#ensurePromise) return this.#ensurePromise;
    this.#ensurePromise = this.#ensureOnce({ skills, consent, onProgress }).catch((error) => {
      this.#ensurePromise = undefined;
      throw error;
    });
    return this.#ensurePromise;
  }

  async #findCompatibleCompleted(skills, dependencies) {
    const environmentsDir = path.join(this.runtimeDir, "environments");
    let entries;
    try { entries = await readdir(environmentsDir, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const environmentDir = path.join(environmentsDir, entry.name);
      try {
        const record = JSON.parse(await readFile(path.join(environmentDir, "runtime.json"), "utf8"));
        if (record?.version !== 1 || JSON.stringify(record.environmentSpec?.dependencies ?? []) !== JSON.stringify(dependencies)) continue;
        assertManagedVersions(record.versions ?? {});
        const pythonPath = path.join(environmentDir, "bin", "python");
        const versions = await validatePython(pythonPath, skills);
        assertManagedVersions(versions);
        return { pythonPath, versions, managed: true, environmentId: record.environmentId ?? entry.name, compatible: true };
      } catch {}
    }
    return undefined;
  }

  async #ensureOnce({ skills, consent, onProgress }) {
    if (this.pythonOverride) {
      const versions = await validatePython(this.pythonOverride, skills);
      return { pythonPath: this.pythonOverride, versions, managed: false, environmentId: "override" };
    }
    if (process.platform !== "linux" || process.arch !== "x64") {
      throw new Error("managed Python currently supports Linux x64 only; set PI_HARNESS_PYTHON to a compatible interpreter");
    }

    const dependencies = [...new Set(skills.flatMap((skill) => skill.python?.dependencies ?? []))].sort();
    const environmentSpec = {
      python: PYTHON_VERSION,
      ipython: IPYTHON_VERSION,
      dill: DILL_VERSION,
      dependencies,
      skills: skills.map((skill) => [skill.id, skill.version, skill.contentHash, skill.python?.srcPath ?? null]),
    };
    const environmentId = hash(JSON.stringify(environmentSpec)).slice(0, 20);
    const environmentDir = path.join(this.runtimeDir, "environments", environmentId);
    const pythonPath = path.join(environmentDir, "bin", "python");
    const completePath = path.join(environmentDir, "runtime.json");
    const useCompleted = async () => {
      if (!await exists(completePath)) return undefined;
      try {
        const versions = await validatePython(pythonPath, skills);
        assertManagedVersions(versions);
        return { pythonPath, versions, managed: true, environmentId };
      } catch {
        return undefined;
      }
    };
    const completed = await useCompleted();
    if (completed) return completed;
    const compatible = await this.#findCompatibleCompleted(skills, dependencies);
    if (compatible) return compatible;

    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const releaseLock = await acquireInstallLock(path.join(this.runtimeDir, "install.lock"));
    try {
      const completedAfterLock = await useCompleted();
      if (completedAfterLock) return completedAfterLock;
      const compatibleAfterLock = await this.#findCompatibleCompleted(skills, dependencies);
      if (compatibleAfterLock) return compatibleAfterLock;
      const allowed = process.env.PI_HARNESS_AUTO_INSTALL === "1" || await consent({
        pythonVersion: PYTHON_VERSION,
        packages: [`ipython==${IPYTHON_VERSION}`, `dill==${DILL_VERSION}`, ...dependencies],
      });
      if (!allowed) throw new Error("Python runtime installation was not approved");
      return await this.#buildManaged({
        skills,
        dependencies,
        environmentId,
        environmentDir,
        environmentSpec,
        pythonPath,
        completePath,
        onProgress,
      });
    } finally {
      await releaseLock();
    }
  }

  async #buildManaged({ skills, dependencies, environmentId, environmentDir, environmentSpec, pythonPath, completePath, onProgress }) {
    const uvPath = await this.#ensureUv(onProgress);
    const pythonInstallDir = path.join(this.runtimeDir, "python");
    const cacheDir = path.join(this.runtimeDir, "cache");
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    onProgress(`Installing managed CPython ${PYTHON_VERSION}`);
    await run(uvPath, [
      "python", "install", PYTHON_VERSION,
      "--install-dir", pythonInstallDir,
      "--no-bin", "--cache-dir", cacheDir, "--no-config", "--no-progress",
    ], { onProgress });
    const managedPython = path.join(pythonInstallDir, `cpython-${PYTHON_VERSION}-linux-x86_64-gnu`, "bin", "python3");
    if (!await exists(managedPython)) throw new Error(`managed Python was not installed at ${managedPython}`);

    await rm(environmentDir, { recursive: true, force: true });
    await mkdir(path.dirname(environmentDir), { recursive: true, mode: 0o700 });
    onProgress(`Creating Python environment ${environmentId}`);
    await run(uvPath, [
      "venv", environmentDir, "--python", managedPython, "--seed", "--cache-dir", cacheDir, "--no-config",
    ], { onProgress });
    await run(uvPath, [
      "pip", "install", "--python", pythonPath,
      `ipython==${IPYTHON_VERSION}`, `dill==${DILL_VERSION}`, ...dependencies,
      "--cache-dir", cacheDir, "--no-config", "--no-progress",
    ], { onProgress });
    const sitePackages = (await run(pythonPath, ["-c", "import site; print(site.getsitepackages()[0])"])).stdout.trim();
    const skillSources = skills.flatMap((skill) => skill.python ? [skill.python.srcPath] : []);
    await writeFile(path.join(sitePackages, "persistent-harness-skills.pth"), `${skillSources.join("\n")}\n`, { mode: 0o600 });
    const versions = await validatePython(pythonPath, skills);
    assertManagedVersions(versions);
    const record = { version: 1, environmentId, environmentSpec, versions };
    const temporary = `${completePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, completePath);
    return { pythonPath, versions, managed: true, environmentId };
  }

  async #ensureUv(onProgress) {
    const binDir = path.join(this.runtimeDir, "bin");
    const uvPath = path.join(binDir, `uv-${UV_VERSION}`);
    if (await exists(uvPath)) return uvPath;
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    const temporaryRoot = path.join(this.runtimeDir, `uv-${process.pid}-${Date.now()}`);
    const archivePath = path.join(temporaryRoot, UV_ARCHIVE);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    try {
      onProgress(`Downloading checksum-pinned uv ${UV_VERSION}`);
      await download(
        `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ARCHIVE}`,
        archivePath,
        UV_SHA256,
      );
      await run("tar", ["-xzf", archivePath, "-C", temporaryRoot]);
      const extracted = path.join(temporaryRoot, "uv-x86_64-unknown-linux-gnu", "uv");
      await chmod(extracted, 0o700);
      await rename(extracted, uvPath);
      await chmod(uvPath, 0o700);
      return uvPath;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export const runtimeVersions = {
  uv: UV_VERSION,
  python: PYTHON_VERSION,
  ipython: IPYTHON_VERSION,
  dill: DILL_VERSION,
};
