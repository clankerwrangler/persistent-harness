import { spawn } from "node:child_process";

export const DEFAULT_CRON_CHECK_TIMEOUT_SECONDS = 30;
export const MAX_CRON_CHECK_TIMEOUT_SECONDS = 120;
export const MAX_CRON_CHECK_COMMAND_BYTES = 4096;
export const MAX_CRON_CHECK_OUTPUT_BYTES = 16 * 1024;
export const CRON_CHECK_FAILURE_ALERT_THRESHOLD = 3;
// A check is a cheap process, not an agent turn, so it may run far more often than a plain job.
export const MIN_CHECKED_INTERVAL_SECONDS = 60;

export function normalizeCronCheck(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("check must be an object");
  for (const key of Object.keys(value)) if (!["command", "timeoutSeconds"].includes(key)) throw new TypeError(`check.${key} is not supported`);
  const { command, timeoutSeconds = DEFAULT_CRON_CHECK_TIMEOUT_SECONDS } = value;
  if (typeof command !== "string" || !command.trim() || command.includes("\0")
    || Buffer.byteLength(command, "utf8") > MAX_CRON_CHECK_COMMAND_BYTES) {
    throw new TypeError(`check.command must be a nonblank shell command of at most ${MAX_CRON_CHECK_COMMAND_BYTES} bytes`);
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_CRON_CHECK_TIMEOUT_SECONDS) {
    throw new TypeError(`check.timeoutSeconds must be an integer from 1 through ${MAX_CRON_CHECK_TIMEOUT_SECONDS}`);
  }
  return { command, timeoutSeconds };
}

// Runs a job's check the way the agent's own shell would. Printed output means "wake the agent with this";
// silence means there is nothing to do. A nonzero exit or timeout is a failed check, whatever it printed.
export function runCronCheck({ command, timeoutSeconds }, { cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    const stdout = []; let stdoutBytes = 0; let stderr = ""; let timedOut = false; let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    let child;
    try { child = spawn("/bin/bash", ["-lc", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ ok: false, error: `could not start: ${error.message}` }); return; }
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes <= MAX_CRON_CHECK_OUTPUT_BYTES) stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-500); });
    child.on("error", (error) => finish({ ok: false, error: `could not start: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (timedOut) return finish({ ok: false, error: `timed out after ${timeoutSeconds} s` });
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        return finish({ ok: false, error: `${code === null ? `killed by ${signal}` : `exited with code ${code}`}${detail}` });
      }
      let output = Buffer.concat(stdout).subarray(0, MAX_CRON_CHECK_OUTPUT_BYTES).toString("utf8").trim();
      if (stdoutBytes > MAX_CRON_CHECK_OUTPUT_BYTES) output += "\n[check output truncated]";
      finish({ ok: true, output });
    });
  });
}
