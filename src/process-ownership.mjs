import { readFile } from "node:fs/promises";

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
