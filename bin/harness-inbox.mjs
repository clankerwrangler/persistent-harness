#!/usr/bin/env node
// Manages who may message the agent through the harness inbox, and where each route leads.
import { writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InboxStore } from "../src/inbox.mjs";

const USAGE = `usage:
  harness-inbox list
  harness-inbox add-sender NAME --key-file PATH [--kind news|maintenance] [--rate PER_HOUR]
  harness-inbox remove-sender NAME
  harness-inbox route ROUTE (--session SESSION_ID | --working-roots)
  harness-inbox remove-route ROUTE
  harness-inbox send ROUTE --key-file PATH --id ID --text TEXT [--url URL]
add-sender writes the new key to --key-file (mode 0600) and never prints it. Running it again replaces the key.`;

function parse(argv) {
  const [command, name, ...rest] = argv; const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--working-roots") { flags.workingRoots = true; continue; }
    if (!flag.startsWith("--") || rest[i + 1] === undefined) throw new Error(USAGE);
    flags[flag.slice(2)] = rest[++i];
  }
  return { command, name, flags };
}

const databasePath = process.env.PI_HARNESS_DB
  || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "harness", "harness.sqlite");

async function main() {
  const { command, name, flags } = parse(process.argv.slice(2));
  if (command === "send") {
    const key = readFileSync(flags["key-file"], "utf8").trim();
    const url = flags.url ?? `http://127.0.0.1:${process.env.PI_HARNESS_INBOX_PORT ?? 8790}`;
    const res = await fetch(`${url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ route: name, id: flags.id, text: flags.text }), signal: AbortSignal.timeout(30_000) });
    console.log(res.status, await res.text());
    process.exitCode = res.ok ? 0 : 1;
    return;
  }
  const store = new InboxStore(databasePath);
  try {
    if (command === "list") console.log(JSON.stringify(store.list(), null, 2));
    else if (command === "add-sender") {
      if (!flags["key-file"]) throw new Error("add-sender needs --key-file");
      const key = store.addSender(name, { kind: flags.kind ?? "news", ratePerHour: flags.rate === undefined ? undefined : Number(flags.rate) });
      writeFileSync(flags["key-file"], `${key}\n`, { mode: 0o600 });
      console.log(`sender ${name} saved; key written to ${flags["key-file"]}`);
    } else if (command === "remove-sender") { store.removeSender(name); console.log(`sender ${name} removed`); }
    else if (command === "route") {
      store.setRoute(name, flags.workingRoots ? { workingRoots: true } : { sessionId: flags.session });
      console.log(`route ${name} saved`);
    } else if (command === "remove-route") { store.removeRoute(name); console.log(`route ${name} removed`); }
    else throw new Error(USAGE);
  } finally { store.close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
