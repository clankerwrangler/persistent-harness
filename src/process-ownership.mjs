import { readFile, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";

function parseProcStat(content) {
  const close = content.lastIndexOf(")");
  if (close < 0) throw new Error("invalid /proc stat record");
  const fields = content.slice(close + 2).trim().split(/\s+/);
  const processGroup = Number(fields[2]); // field 5; fields[0] is field 3
  const startTime = fields[19]; // field 22
  if (!Number.isInteger(processGroup) || !startTime) throw new Error("invalid /proc process identity");
  return { processGroup, startTime };
}

function hasEnvironmentToken(buffer, token) {
  const expected = Buffer.from(`PI_HARNESS_ACTOR_TOKEN=${token}`);
  return buffer.toString("utf8").split("\0").some((entry) => Buffer.from(entry).equals(expected));
}

export async function captureOwnedProcessIdentity(pid, ownerToken) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("owned process PID is invalid");
  if (typeof ownerToken !== "string" || !ownerToken) throw new Error("owned process token is invalid");
  const [stat, environment] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/environ`),
  ]);
  const parsed = parseProcStat(stat);
  if (parsed.processGroup !== pid) throw new Error(`owned process ${pid} is not its process-group leader`);
  if (!hasEnvironmentToken(environment, ownerToken)) throw new Error(`owned process ${pid} does not carry its ownership token`);
  return { version: 1, pid, processGroup: parsed.processGroup, startTime: parsed.startTime, ownerToken };
}

export async function verifyOwnedProcessIdentity(identity) {
  if (!identity || identity.version !== 1 || !Number.isInteger(identity.pid) || identity.pid <= 0
    || identity.processGroup !== identity.pid || typeof identity.startTime !== "string"
    || typeof identity.ownerToken !== "string" || !identity.ownerToken) return false;
  try {
    const [stat, environment] = await Promise.all([
      readFile(`/proc/${identity.pid}/stat`, "utf8"),
      readFile(`/proc/${identity.pid}/environ`),
    ]);
    const parsed = parseProcStat(stat);
    return parsed.processGroup === identity.processGroup
      && parsed.startTime === identity.startTime
      && hasEnvironmentToken(environment, identity.ownerToken);
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
}

async function waitForIdentityExit(identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await verifyOwnedProcessIdentity(identity)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !await verifyOwnedProcessIdentity(identity);
}

export async function terminateOwnedProcess(identity, { graceMs = 1000 } = {}) {
  if (!await verifyOwnedProcessIdentity(identity)) return { terminated: false, reason: "identity-mismatch-or-exited" };
  try { process.kill(-identity.processGroup, "SIGTERM"); } catch (error) {
    if (error?.code === "ESRCH") return { terminated: true, signal: null };
    throw error;
  }
  if (await waitForIdentityExit(identity, graceMs)) return { terminated: true, signal: "SIGTERM" };
  if (!await verifyOwnedProcessIdentity(identity)) return { terminated: true, signal: "SIGTERM" };
  try { process.kill(-identity.processGroup, "SIGKILL"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitForIdentityExit(identity, 1000);
  return { terminated: !await verifyOwnedProcessIdentity(identity), signal: "SIGKILL" };
}

export const processOwnershipInternals = { hasEnvironmentToken, parseProcStat };

// Called only for tombstoned roots with owned scratch pending reclamation.
// A failed/incomplete sample is unknown, never evidence that work has stopped.
export async function quiescentScratchProcessRoots(rootIds, { maxProcesses = 4096, maxBytes = 8 * 1024 * 1024, timeoutMs = 500 } = {}) {
  const roots = new Set(rootIds), active = new Set();
  if (!roots.size) return roots;
  const deadline = performance.now() + timeoutMs;
  let count = 0, bytes = 0, reader;
  const boundedRead = async (file, limit) => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead; bytes += result.bytesRead;
        if (bytes > maxBytes || performance.now() > deadline) throw new Error("incomplete ownership sample");
      }
      if (length > limit) throw new Error("incomplete ownership sample");
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  };
  try {
    reader = await opendir("/proc");
    for await (const entry of reader) {
      if (!/^[0-9]+$/.test(entry.name)) continue;
      // This exact executing service is the cleanup owner, not a family tool.
      // Its PID/birth cannot be substituted while this call is executing.
      if (entry.name === String(process.pid)) continue;
      if (++count > maxProcesses || performance.now() > deadline) return new Set();
      let processDirectory;
      try {
        processDirectory = await open(`/proc/${entry.name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if ((await processDirectory.stat()).uid !== process.geteuid()) continue;
        const base = `/proc/self/fd/${processDirectory.fd}`;
        const before = (await boundedRead(`${base}/stat`, 4096)).toString("utf8");
        const first = before.slice(before.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (first.length < 20) return new Set();
        if (["Z", "X", "x"].includes(first[0])) continue;
        // Extract only exact root markers. Environment bytes remain local and ephemeral.
        const environment = await boundedRead(`${base}/environ`, 64 * 1024);
        const prefix = "PI_HARNESS_ROOT_SESSION_ID=";
        const found = environment.toString("utf8").split("\0").filter(value => value.startsWith(prefix))
          .map(value => value.slice(prefix.length)).filter(value => roots.has(value));
        const after = (await boundedRead(`${base}/stat`, 4096)).toString("utf8");
        const last = after.slice(after.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (last.length < 20 || first[19] !== last[19]) return new Set();
        for (const root of found) active.add(root);
      } catch {
        // Process churn, permission failure, PID reuse, and unreadable ownership defer reclamation.
        return new Set();
      } finally { await processDirectory?.close(); }
    }
    if (performance.now() > deadline) return new Set();
    return new Set([...roots].filter(root => !active.has(root)));
  } catch { return new Set(); }
  finally { try { await reader?.close(); } catch {} }
}
