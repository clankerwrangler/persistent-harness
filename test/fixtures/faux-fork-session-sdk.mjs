import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Pure session-helper prerequisites for this isolated faux-actor test process.
// Neither a stock SDK namespace, CLI, provider, nor worker is evaluated.
const sessionApi = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export const calls = { contexts: 0, creates: 0, openedFiles: [], names: [], forks: [] };
export function buildSessionContext(entries) {
  if (entries.length) throw new Error("faux fork fixture requires an empty source branch");
  calls.contexts++; return { messages: [] };
}
export class SessionManager {
  constructor(file, directory, cwd, header) { Object.assign(this, { file, directory, cwd, header }); }
  static create(cwd) {
    calls.creates++; const directory = path.join(cwd, "faux-pi-sessions");
    mkdirSync(directory, { recursive: true });
    return new SessionManager(path.join(directory, randomUUID()+".jsonl"), directory, cwd);
  }
  static open(file, directory, cwd) {
    calls.openedFiles.push(file);
    if (!readFileSync(file, "utf8")) writeFileSync(file, JSON.stringify({ type: "session", version: 3,
      id: randomUUID(), timestamp: new Date().toISOString(), cwd })+"\\n");
    const header = JSON.parse(readFileSync(file, "utf8").split("\\n", 1)[0]);
    return new SessionManager(file, directory, header.cwd, header);
  }
  getSessionDir() { return this.directory; }
  getSessionFile() { return this.file; }
  getCwd() { return this.cwd; }
  getHeader() { return this.header; }
  getSessionId() { return this.header.id; }
  appendSessionInfo(name) { calls.names.push(name); this.append({ type: "session_info", name }); }
  appendCustomMessageEntry(customType, content, display, details) {
    calls.forks.push({ customType, content, display, details });
    this.append({ type: "custom_message", customType, content, display, details });
  }
  append(entry) { appendFileSync(this.file, JSON.stringify({ id: randomUUID(), parentId: null,
    timestamp: new Date().toISOString(), ...entry })+"\\n"); }
}
`;

export async function fauxForkSessionSdk(t, root) {
  const modules = path.join(root, "faux-sdk", "node_modules"), agent = path.join(modules, "@earendil-works/pi-coding-agent");
  for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core"]) {
    const directory = path.join(modules, "@earendil-works", name); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`,
      version: "0.99.1", type: "module", dependencies: name === "pi-coding-agent"
        ? { "@earendil-works/pi-ai": "0.99.1", "@earendil-works/pi-agent-core": "0.99.1" }
        : name === "pi-agent-core" ? { "@earendil-works/pi-ai": "0.99.1" } : {},
      exports: name === "pi-coding-agent" ? { ".": "./forbidden.mjs", "./programmatic": "./session-api.mjs" } : {} }));
  }
  await writeFile(path.join(agent, "forbidden.mjs"), 'throw new Error("full SDK loading is outside the faux session fixture");\n');
  const entry = path.join(agent, "session-api.mjs"); await writeFile(entry, sessionApi);
  const previous = Object.fromEntries(["PI_HARNESS_PI_MODULE", "PI_HARNESS_PI_COMMAND"].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.PI_HARNESS_PI_MODULE = agent; delete process.env.PI_HARNESS_PI_COMMAND;
  return { calls: (await import(pathToFileURL(entry).href)).calls, sessionDirectory: path.join(root, "faux-pi-sessions") };
}
