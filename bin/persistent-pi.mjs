#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { HarnessClient } from "../src/client.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const supervisorBin = path.join(packageRoot, "bin", "harness-supervisor.mjs");

function parse(argv) {
  const values = { cwd: process.cwd(), json: false, wait: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--list", "--create", "--json", "--wait"].includes(flag)) values[flag.slice(2).replaceAll("-", "_")] = true;
    else if (["--session", "--attach", "--cwd", "--name", "--provider", "--model", "--thinking", "--prompt", "--behavior", "--socket", "--db", "--pid"].includes(flag)) {
      const value = argv[++index]; if (!value) throw new Error(`${flag} requires a value`); values[flag.slice(2)] = value;
    } else if (["-h", "--help"].includes(flag)) values.help = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  return values;
}
function paths(options) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"); const runtime = path.join(agentDir, "harness");
  return { socketPath: path.resolve(options.socket || process.env.PI_HARNESS_SOCKET || path.join(runtime, "supervisor.sock")), databasePath: path.resolve(options.db || process.env.PI_HARNESS_DATABASE || path.join(runtime, "harness.sqlite")), pidPath: path.resolve(options.pid || process.env.PI_HARNESS_PID || path.join(runtime, "supervisor.pid")) };
}
async function ensure(runtime) {
  try {
    const rollout = JSON.parse(await readFile(path.join(path.dirname(runtime.databasePath), "phase-p-rollout.json"), "utf8"));
    if (rollout.state !== "complete") throw new Error(rollout.state === "waiting-for-legacy-ui-exit"
      ? "Phase P rollout is waiting for the legacy Pi UI to close; close it before launching persistent-pi"
      : `Phase P rollout is not complete: ${rollout.state}`);
  } catch (error) { if (error?.code !== "ENOENT" && !String(error?.message).startsWith("Phase P rollout")) throw error; if (String(error?.message).startsWith("Phase P rollout")) throw error; }
  await execFileAsync(process.execPath, [supervisorBin, "ensure", "--socket", runtime.socketPath, "--db", runtime.databasePath, "--pid", runtime.pidPath], { env: process.env, timeout: 15_000 });
}
function cleanInputMarker(text) { return String(text).replace(/\n\n<!-- persistent-harness-input:[^>]+ -->/g, ""); }
function messageText(message) {
  if (!message) return ""; if (typeof message.content === "string") return cleanInputMarker(message.content);
  if (!Array.isArray(message.content)) return "";
  return cleanInputMarker(message.content.map((part) => part?.type === "text" ? part.text : part?.type === "thinking" ? "" : part?.type === "toolCall" ? `[tool ${part.name}]` : "").filter(Boolean).join(""));
}
function renderEntry(entry) {
  if (entry.type === "custom_message") return `agent> ${typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)}`;
  if (entry.type !== "message") return null; const role = entry.message?.role;
  if (role === "user") return `you> ${messageText(entry.message)}`;
  if (role === "assistant") return `agent> ${messageText(entry.message)}`;
  if (role === "toolResult") return `tool ${entry.message.toolName}> ${messageText(entry.message)}`;
  return null;
}
function sessionLine(session) { return `${session.activity === "working" ? "●" : session.activity === "delegating" ? "◇" : "○"} ${session.name} ${session.shortId} [d${session.depth}] ${session.activity}/${session.lifecycle}${session.attachmentCount ? ` · ${session.attachmentCount} attached` : ""}`; }
function replayText(events) { return (events ?? []).map((item) => item.event?.type === "message_update" && item.event.assistantMessageEvent?.type === "text_delta" ? item.event.assistantMessageEvent.delta : "").join(""); }
async function waitSettled(client, sessionId, timeoutMs = 120_000) {
  const initial = await client.request("get_actor_state", { sessionId }); if (!initial.state.isStreaming) return;
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for actor settlement")); }, timeoutMs); const listener = (frame) => { if (frame.event === "actor_event" && frame.data?.sessionId === sessionId && frame.data?.event?.type === "agent_settled") { cleanup(); resolve(); } }; const cleanup = () => { clearTimeout(timer); client.off("event", listener); }; client.on("event", listener); });
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log("persistent-pi [--list|--create] [--session ID|NAME] [--cwd PATH] [--name NAME] [--provider P --model M] [--thinking LEVEL] [--prompt TEXT --wait] [--json]"); return; }
  const runtime = paths(options); await ensure(runtime);
  const client = new HarnessClient({ socketPath: runtime.socketPath, requestTimeoutMs: 120_000 });
  const registration = await client.start({ registrationType: "register_client", clientInstanceId: randomUUID() });
  if (!registration) throw new Error("could not connect to persistent harness supervisor");
  let selected = options.session || options.attach || null;
  if (options.list) { const result = await client.request("list_sessions"); if (options.json) console.log(JSON.stringify(result, null, 2)); else result.sessions.forEach((session) => console.log(sessionLine(session))); await client.stop(); return; }
  if (options.create || (!selected && registration.sessions.length === 0)) {
    const result = await client.request("create_root", { cwd: path.resolve(options.cwd), repositoryRoot: null, name: options.name ?? null, provider: options.provider ?? null, model: options.model ?? null, thinkingLevel: options.thinking ?? null });
    selected = result.admission.sessionId;
    if (options.json && !options.prompt) console.log(JSON.stringify(result, null, 2));
  }
  if (!selected) {
    console.log("Sessions:"); registration.sessions.forEach((session) => console.log(`  ${sessionLine(session)}`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    selected = await new Promise((resolve) => rl.question("Attach by name or ID (blank creates a root): ", (answer) => { rl.close(); resolve(answer.trim()); }));
    if (!selected) { const result = await client.request("create_root", { cwd: path.resolve(options.cwd), repositoryRoot: null, name: options.name ?? null, provider: options.provider ?? null, model: options.model ?? null, thinkingLevel: options.thinking ?? null }); selected = result.admission.sessionId; }
  }
  const attached = await client.request("subscribe_session", { selector: selected }); selected = attached.session.sessionId;
  let interactiveRl = null;
  const ask = (prompt) => new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(""); return; }
    if (interactiveRl) { interactiveRl.question(prompt, resolve); return; }
    const temporary = readline.createInterface({ input: process.stdin, output: process.stdout });
    temporary.question(prompt, (answer) => { temporary.close(); resolve(answer); });
  });
  let dialogTail = Promise.resolve();
  const handleExtensionUi = async (actorEvent) => {
    if (actorEvent?.type !== "extension_ui_request") return;
    if (actorEvent.method === "notify") { console.error(actorEvent.message); return; }
    if (!["select", "confirm", "input", "editor"].includes(actorEvent.method)) return;
    let reply;
    if (actorEvent.method === "confirm") {
      const answer = await ask(`${actorEvent.title}: ${actorEvent.message} [y/N] `);
      reply = { confirmed: /^(y|yes)$/i.test(answer.trim()) };
    } else if (actorEvent.method === "select") {
      console.error(`${actorEvent.title}: ${actorEvent.options.map((option, index) => `${index + 1}) ${option}`).join("  ")}`);
      const answer = await ask("Selection: "); const index = Number(answer) - 1;
      reply = Number.isInteger(index) && actorEvent.options[index] ? { value: actorEvent.options[index] } : { cancelled: true };
    } else {
      const answer = await ask(`${actorEvent.title}${actorEvent.placeholder ? ` (${actorEvent.placeholder})` : ""}: `);
      reply = answer ? { value: answer } : { cancelled: true };
    }
    await client.request("respond_extension_ui", { sessionId: selected, uiRequestId: actorEvent.id, ...reply });
  };
  const queueExtensionUi = (actorEvent) => { dialogTail = dialogTail.then(() => handleExtensionUi(actorEvent)).catch((error) => console.error(error instanceof Error ? error.message : String(error))); };
  client.on("event", (frame) => { if (frame.event === "actor_event" && frame.data?.sessionId === selected) queueExtensionUi(frame.data.event); });
  for (const retained of attached.events ?? []) queueExtensionUi(retained.event);
  const history = await client.request("get_actor_entries", { sessionId: selected, since: null });
  if (!options.json) { console.log(`Attached ${sessionLine(attached.session)}`); if (history.truncated) console.log("… earlier entries omitted …"); for (const entry of history.entries) { const line = renderEntry(entry); if (line) console.log(line); } const partial = replayText(attached.events); if (partial) process.stdout.write(`agent> ${partial}`); }
  if (options.prompt) {
    const accepted = await client.request("submit_input", { sessionId: selected, message: options.prompt, behavior: options.behavior || "auto" });
    if (options.wait) await waitSettled(client, selected);
    if (options.json) console.log(JSON.stringify({ attached: attached.session, accepted, ...(options.wait ? { entries: await client.request("get_actor_entries", { sessionId: selected, since: history.leafId }) } : {}) }, null, 2));
    await client.stop(); return;
  }

  let streamingLine = false;
  client.on("event", (frame) => {
    if (frame.event === "navigator_changed") return;
    if (frame.event !== "actor_event" || frame.data?.sessionId !== selected) return;
    const actorEvent = frame.data.event;
    if (actorEvent?.type === "message_update" && actorEvent.assistantMessageEvent?.type === "text_delta") { if (!streamingLine) { process.stdout.write("agent> "); streamingLine = true; } process.stdout.write(actorEvent.assistantMessageEvent.delta); }
    else if (actorEvent?.type === "message_end" && streamingLine) { process.stdout.write("\n"); streamingLine = false; }
  });
  console.log("Commands: :sessions, :attach NAME|ID, :new [NAME], :abort, :quit");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " }); interactiveRl = rl; rl.prompt();
  rl.on("line", async (line) => {
    rl.pause();
    try {
      const input = line.trim();
      if (!input) return;
      if (input === ":quit") { rl.close(); return; }
      if (input === ":sessions") { const result = await client.request("list_sessions"); result.sessions.forEach((session) => console.log(sessionLine(session))); }
      else if (input.startsWith(":attach ")) { await client.request("unsubscribe_session", { sessionId: selected }); const next = await client.request("subscribe_session", { selector: input.slice(8).trim() }); selected = next.session.sessionId; console.log(`Attached ${sessionLine(next.session)}`); const entries = await client.request("get_actor_entries", { sessionId: selected, since: null }); for (const entry of entries.entries) { const rendered = renderEntry(entry); if (rendered) console.log(rendered); } }
      else if (input.startsWith(":new")) { const name = input.slice(4).trim() || null; const created = await client.request("create_root", { cwd: path.resolve(options.cwd), repositoryRoot: null, name, provider: options.provider ?? null, model: options.model ?? null, thinkingLevel: options.thinking ?? null }); await client.request("unsubscribe_session", { sessionId: selected }); const next = await client.request("subscribe_session", { selector: created.admission.sessionId }); selected = next.session.sessionId; console.log(`Attached ${sessionLine(next.session)}`); }
      else if (input === ":abort") await client.request("abort_session", { sessionId: selected });
      else await client.request("submit_input", { sessionId: selected, message: line, behavior: "auto" });
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    finally { if (!rl.closed) { rl.resume(); rl.prompt(); } }
  });
  await new Promise((resolve) => rl.once("close", resolve)); await client.request("unsubscribe_session", { sessionId: selected }).catch(() => {}); await client.stop();
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
