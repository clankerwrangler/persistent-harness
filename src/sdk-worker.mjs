import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadExternalPi } from "./external-pi.mjs";
import { PiRpcLineDecoder } from "./session-actor.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MAX_WORKER_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const string = (value, name) => {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
};
const boolean = (value, name) => {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
};
function choice(value, values, name) {
  if (!values.includes(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
const errorText = (error) => error instanceof Error ? error.message : String(error);

/** UI requests stay on the RPC connection; this adapter never opens a terminal. */
export class RpcDialogBroker {
  #pending = new Map();
  #closed = false;
  constructor(publish, { maxPending = 128, getTheme = () => undefined, onChange = () => {} } = {}) {
    this.publish = publish;
    this.maxPending = maxPending;
    this.getTheme = getTheme;
    this.onChange = onChange;
    const send = (method, fields) => {
      if (!this.#closed) this.publish({ type: "extension_ui_request", id: randomUUID(), method, ...fields });
    };
    const noop = () => {};
    this.ui = {
      select: (title, options, opts) => this.dialog("select", { title, options }, opts),
      confirm: (title, message, opts) => this.dialog("confirm", { title, message }, opts),
      input: (title, placeholder, opts) => this.dialog("input", { title, placeholder }, opts),
      editor: (title, prefill, opts) => this.dialog("editor", { title, prefill }, opts),
      notify: (message, notifyType = "info") => send("notify", { message, notifyType }),
      setStatus: (statusKey, statusText) => send("setStatus", { statusKey, statusText }),
      setWidget: (widgetKey, content, options) => {
        if (content === undefined || Array.isArray(content)) send("setWidget", {
          widgetKey, widgetLines: content, widgetPlacement: options?.placement,
        });
      },
      setTitle: (title) => send("setTitle", { title }),
      setEditorText: (text) => send("set_editor_text", { text }),
      pasteToEditor: (text) => send("set_editor_text", { text }),
      getEditorText: () => "", getToolsExpanded: () => false,
      custom: async () => undefined, onTerminalInput: () => noop,
      getAllThemes: () => [], getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching not supported in RPC mode" }),
      setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop, setFooter: noop, setHeader: noop,
      setEditorComponent: noop, getEditorComponent: () => undefined,
      addAutocompleteProvider: noop, setToolsExpanded: noop,
    };
    Object.defineProperty(this.ui, "theme", { get: () => this.getTheme(), enumerable: true });
  }
  get pendingCount() { return this.#pending.size; }
  dialog(method, fields, opts = {}) {
    const defaultValue = method === "confirm" ? false : undefined;
    if (this.#closed || opts.signal?.aborted) return Promise.resolve(defaultValue);
    if (this.#pending.size >= this.maxPending) return Promise.reject(new Error("Too many pending extension UI dialogs"));
    if (opts.timeout !== undefined && (!Number.isFinite(opts.timeout) || opts.timeout < 0 || opts.timeout > 2_147_483_647)) {
      return Promise.reject(new TypeError("Invalid extension UI timeout"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (!this.#pending.delete(id)) return false;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", cancel);
        this.onChange();
        return true;
      };
      const finish = (value) => { if (cleanup()) resolve(value); };
      const cancel = () => finish(defaultValue);
      this.#pending.set(id, { method, finish, cancel });
      opts.signal?.addEventListener("abort", cancel, { once: true });
      if (opts.timeout > 0) timer = setTimeout(cancel, opts.timeout);
      try { this.publish({ type: "extension_ui_request", id, method, ...fields, timeout: opts.timeout }); }
      catch (error) { if (cleanup()) reject(error); }
    });
  }
  respond(frame) {
    const pending = this.#pending.get(frame.id);
    if (!pending) return false;
    if (frame.cancelled === true) pending.cancel();
    else if (pending.method === "confirm") {
      if (typeof frame.confirmed !== "boolean") return false;
      pending.finish(frame.confirmed);
    } else {
      if (typeof frame.value !== "string") return false;
      pending.finish(frame.value);
    }
    return true;
  }
  cancelAll() { for (const pending of this.#pending.values()) pending.cancel(); }
  close() { this.#closed = true; this.cancelAll(); }
}

/** Convert public SDK deltas to the stock RPC event shape without cumulative copies. */
export function toWorkerRpcEvent(event) {
  if (event.type !== "message_update") return event;
  const { partial, ...delta } = event.assistantMessageEvent;
  if (["start", "done", "error"].includes(delta.type)) return null;
  if (delta.type === "toolcall_start") {
    const block = (partial ?? event.message)?.content?.[delta.contentIndex];
    if (block?.type === "toolCall") { delta.id ??= block.id; delta.toolName ??= block.name; }
  }
  return { type: "message_update", usage: event.usage ?? (partial ?? event.message)?.usage, assistantMessageEvent: delta };
}

function dormantResources(sdk, resources) {
  const empty = { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() };
  const wrapper = { getExtensions: () => empty };
  for (const name of ["getSkills", "getPrompts", "getThemes", "getAgentsFiles", "getSystemPrompt", "getSystemPromptSource",
    "getAppendSystemPrompt", "getAppendSystemPromptSources", "extendResources"]) {
    wrapper[name] = (...args) => resources[name](...args);
  }
  // Session replacement/reload belongs to the supervisor/active owner, not the dormant service.
  wrapper.reload = async () => { throw new Error("Reload must use the active actor owner"); };
  return wrapper;
}

function stagingBindings(runner, models) {
  const unavailable = () => { throw new Error("Actor core actions are unavailable before coordinator startup"); };
  const actions = Object.fromEntries(["sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "getSessionName", "setLabel",
    "getActiveTools", "getAllTools", "setActiveTools", "refreshTools", "getCommands", "setModel", "getThinkingLevel", "setThinkingLevel"]
    .map((key) => [key, unavailable]));
  const context = Object.fromEntries(["getModel", "getScopedModels", "isIdle", "isProjectTrusted", "getSignal", "abort",
    "hasPendingMessages", "shutdown", "getContextUsage", "compact", "getSystemPrompt", "getSystemPromptOptions"]
    .map((key) => [key, unavailable]));
  runner.bindCore(actions, context, {
    registerProvider: (name, config) => models.registerProvider(name, config),
    registerNativeProvider: (provider) => models.registerNativeProvider(provider),
    unregisterProvider: (name) => models.unregisterProvider(name),
  });
}

function discoveredPaths(paths) {
  return Object.fromEntries(["skillPaths", "promptPaths", "themePaths"].map((kind) => [kind,
    (paths[kind] ?? []).map(({ path: resourcePath, extensionPath }) => ({
      path: resourcePath,
      metadata: { source: `extension:${extensionPath}`, scope: "temporary", origin: "top-level",
        baseDir: extensionPath.startsWith("<") ? undefined : path.dirname(extensionPath) },
    })),
  ]));
}

export class SDKWorker {
  #closed;
  constructor({ session, coordinator, runner, resources, sdk, models, projectContext, broker, publish, lifecycle }) {
    Object.assign(this, { session, coordinator, runner, resources, sdk, models, projectContext, broker, publish, lifecycle });
    this.unsubscribeService = session.subscribe((event) => {
      if (["session_info_changed", "thinking_level_changed"].includes(event.type)) publish(event);
    });
  }
  getMessages() {
    const manager = this.session.sessionManager;
    return this.projectContext({ entries: manager.getEntries(), leafId: manager.getLeafId(),
      buildSessionContext: this.sdk.buildSessionContext, mode: "ordinary" }).messages;
  }
  async mutate(operation) {
    if (this.coordinator.isBusy || !this.session.isIdle) throw new Error("Actor must be idle for this operation");
    // The lease must also block extension-originated sends, not just RPC prompts.
    if (typeof this.coordinator.withServiceMutation !== "function") throw new Error("Owner mutation lease integration is incomplete");
    return this.coordinator.withServiceMutation(async () => {
      const leaf = this.session.sessionManager.getLeafId();
      try { return await operation(); }
      finally {
        if (leaf !== this.session.sessionManager.getLeafId()) await this.lifecycle.afterCommit?.();
      }
    });
  }
  async mutateModel(operation, source = "set") {
    return this.mutate(async () => {
      const previousModel = this.session.model;
      const previousLevel = this.session.thinkingLevel;
      const result = await operation();
      if (this.session.thinkingLevel !== previousLevel) await this.runner.emit({ type: "thinking_level_select",
        level: this.session.thinkingLevel, previousLevel });
      if (this.session.model !== previousModel) await this.runner.emit({ type: "model_select",
        model: this.session.model, previousModel, source });
      return result;
    });
  }
  async handle(command) {
    if (this.#closed) throw new Error("Actor worker is closing");
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new TypeError("RPC command must be an object");
    const { session, coordinator, runner, models } = this;
    const manager = session.sessionManager;
    const persist = command.persist === undefined ? false : boolean(command.persist, "persist");
    switch (command.type) {
      case "get_state": return coordinator.getState();
      case "prompt": case "steer": case "follow_up": {
        string(command.message, "message");
        if (command.messageId != null) string(command.messageId, "messageId");
        const images = command.images ?? [];
        if (!Array.isArray(images) || images.some((image) => image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string")) {
          throw new TypeError("images must contain ImageContent objects");
        }
        let behavior = command.type === "prompt" ? "auto" : command.type;
        if (command.streamingBehavior !== undefined) {
          if (command.type !== "prompt") throw new TypeError("streamingBehavior is only valid for prompt");
          behavior = choice(command.streamingBehavior, ["steer", "followUp"], "streamingBehavior") === "followUp" ? "follow_up" : "steer";
        }
        return coordinator.submit(command.message, behavior, images, command.messageId ?? null, {
          source: "rpc", expandPromptTemplates: command.expandPromptTemplates === undefined ? true : boolean(command.expandPromptTemplates, "expandPromptTemplates"),
        });
      }
      case "abort": this.broker.cancelAll(); await coordinator.abort(); return undefined;
      case "compact":
        if (command.customInstructions !== undefined) string(command.customInstructions, "customInstructions");
        return coordinator.compact(command.customInstructions);
      case "clear_queue":
        if (typeof coordinator.clearQueue !== "function") throw new Error("Owner clear_queue integration is incomplete");
        return coordinator.clearQueue();
      case "get_messages": return { messages: this.getMessages() };
      case "get_entries": {
        const entries = manager.getEntries();
        if (command.since == null) return { entries, leafId: manager.getLeafId() };
        const index = entries.findIndex((entry) => entry.id === string(command.since, "since"));
        if (index < 0) throw new Error("Unknown session entry cursor");
        return { entries: entries.slice(index + 1), leafId: manager.getLeafId() };
      }
      case "get_tree": return { tree: manager.getTree(), leafId: manager.getLeafId() };
      case "get_session_stats": return { ...session.getSessionStats(), contextUsage: runner.createContext().getContextUsage() };
      case "get_available_models": return { models: await models.getAvailable(undefined, { signal: AbortSignal.timeout(15000) }) };
      case "get_thinking_level": return { level: session.thinkingLevel };
      case "get_available_thinking_levels": return { levels: session.getAvailableThinkingLevels() };
      case "set_thinking_level": return this.mutateModel(async () => {
        session.setThinkingLevel(choice(command.level, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "thinking level"), { persist });
      });
      case "cycle_thinking_level": return this.mutateModel(async () => ({ level: session.cycleThinkingLevel({ persist }) ?? null }));
      case "set_model": return this.mutateModel(async () => {
        const model = models.getModel(string(command.provider, "provider"), string(command.modelId, "modelId"));
        if (!model) throw new Error("Model not found");
        await session.setModel(model, { persist });
        return session.model;
      });
      case "cycle_model": return this.mutateModel(() => session.cycleModel(
        choice(command.direction ?? "forward", ["forward", "backward"], "direction"), { persist }).then((result) => result ?? null), "cycle");
      case "set_steering_mode": case "set_follow_up_mode": return this.mutate(async () => {
        const mode = choice(command.mode, ["all", "one-at-a-time"], "queue mode");
        const steering = command.type === "set_steering_mode";
        // Stock setters persist by default; respect the supervisor's explicit session-only request.
        if (command.persist !== false) {
          if (steering) session.setSteeringMode(mode); else session.setFollowUpMode(mode);
        } else if (steering) session.agent.steeringMode = mode;
        else session.agent.followUpMode = mode;
        if (steering) coordinator.steeringMode = mode; else coordinator.followUpMode = mode;
      });
      case "set_auto_compaction": return this.mutate(async () => session.setAutoCompactionEnabled(boolean(command.enabled, "enabled")));
      case "set_auto_retry": return this.mutate(async () => session.setAutoRetryEnabled(boolean(command.enabled, "enabled")));
      case "abort_retry": await coordinator.abort(); return undefined;
      case "set_session_name": case "rename": return this.mutate(async () => {
        session.setSessionName(string(command.name, "name"));
        await runner.emit({ type: "session_info_changed", name: session.sessionName });
      });
      case "get_fork_messages": return { messages: session.getUserMessagesForForking() };
      case "get_last_assistant_text": {
        const message = this.getMessages().findLast((message) => message.role === "assistant");
        return { text: message ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : null };
      }
      case "get_commands": return { commands: [
        ...runner.getRegisteredCommands().map((cmd) => ({ name: cmd.invocationName ?? cmd.name, description: cmd.description, source: "extension", sourceInfo: cmd.sourceInfo, path: cmd.sourceInfo?.path })),
        ...this.resources.getPrompts().prompts.map((item) => resourceCommand(item, "prompt")),
        ...(session.settingsManager.getEnableSkillCommands() ? this.resources.getSkills().skills.map((item) => resourceCommand(item, "skill")) : []),
      ] };
      case "export_html": return this.mutate(async () => ({ path: await session.exportToHtml(command.outputPath) }));
      case "new_session": case "switch_session": case "fork": case "clone":
        throw new Error("Session replacement belongs to the persistent-harness supervisor");
      default: throw new Error(`Unknown actor RPC command: ${String(command.type)}`);
    }
  }
  close() {
    if (!this.#closed) {
      this.broker.close();
      this.#closed = (async () => {
        try { await this.coordinator.close(); }
        finally {
          this.unsubscribeService();
          this.session.dispose();
          this.runner.invalidate("Actor worker closed");
          await this.session.settingsManager.flush();
        }
      })();
    }
    return this.#closed;
  }
}

function resourceCommand(item, source) {
  const scope = item.sourceInfo?.scope;
  return { name: source === "skill" ? `skill:${item.name}` : item.name, description: item.description, source, sourceInfo: item.sourceInfo,
    location: scope === "user" ? "user" : scope === "project" ? "project" : "path", path: item.filePath };
}

/** One literal SessionManager; active runner and dormant services have distinct runtimes. */
export async function bootstrapSDKWorker({ argv = [], cwd = process.cwd(), env = process.env,
  publish, broker = new RpcDialogBroker(publish), external, Coordinator, extensionFactory, createNativeAdapter, projectContext, planRecovery,
  lifecycle = {}, onTiming, createCompactionDriver, createNavigationDriver } = {}) {
  external ??= await loadExternalPi({ env, cwd });
  const { sdk, api, core, responsesApi } = external;
  Coordinator ??= (await import("./actor-coordinator.mjs")).ActorCoordinator;
  const usesHarnessFactory = extensionFactory == null;
  extensionFactory ??= (await import("./extension.mjs")).default;
  createNativeAdapter ??= (await import("./native-provider.mjs")).createNativeProviderAdapter;
  createCompactionDriver ??= (await import("./actor-compaction.mjs")).createCompactionDriver;
  createNavigationDriver ??= (await import("./actor-navigation.mjs")).createNavigationDriver;
  projectContext ??= (await import("./canonical-context.mjs")).projectCanonicalContext;
  planRecovery ??= (await import("./canonical-context.mjs")).planUnknownRecovery;
  const options = sdk.parseArgs(argv);
  if (options.diagnostics.some((item) => item.type === "error")) throw new Error(options.diagnostics.map((item) => item.message).join("; "));
  if (options.mode !== "rpc" || options.messages.length || options.fileArgs.length || options.resume || options.fork || options.print || options.export || options.apiKey) {
    throw new Error("Actor requires --mode rpc and supervisor-owned session/input/auth configuration");
  }
  const agentDir = path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const trust = options.projectTrustOverride ?? new sdk.ProjectTrustStore(agentDir).get(cwd)
    ?? (!sdk.hasTrustRequiringProjectResources(cwd) || settings.getDefaultProjectTrust() === "always");
  settings.setProjectTrusted(trust);
  const ownEntry = await realpath(path.join(PACKAGE_ROOT, "index.ts"));
  const additionalExtensionPaths = [];
  for (const source of options.extensions ?? []) {
    let identity;
    try { identity = await realpath(path.resolve(cwd, source)); } catch {}
    if (identity !== ownEntry) additionalExtensionPaths.push(source);
  }
  const resources = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths, extensionFactories: [{ name: "persistent-harness", factory: (pi) => extensionFactory(pi, lifecycle) }],
    extensionsOverride: usesHarnessFactory ? (loaded) => {
      // This factory replaces our index.ts re-export, not an unrelated extension.
      // Identify that public loader result before stock derives command/tool SourceInfo.
      const owned = loaded.extensions.filter((extension) => extension.path === "<inline:persistent-harness>");
      if (owned.length !== 1) throw new Error(`Expected exactly one owned harness extension, received ${owned.length}`);
      const [own] = owned;
      own.path = ownEntry; own.resolvedPath = ownEntry;
      return loaded;
    } : undefined,
    noExtensions: options.noExtensions, noSkills: options.noSkills, noPromptTemplates: options.noPromptTemplates,
    noThemes: options.noThemes, noContextFiles: options.noContextFiles,
    additionalSkillPaths: options.skills, additionalPromptTemplatePaths: options.promptTemplates,
    additionalThemePaths: options.themes, systemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt,
  });
  await resources.reload();
  const active = resources.getExtensions();
  if (active.errors.length) throw new Error(`Extension loading failed: ${active.errors.map((item) => item.error).join("; ")}`);
  const models = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false, signal: AbortSignal.timeout(15000) });
  const sessionDir = options.sessionDir ?? env.PI_CODING_AGENT_SESSION_DIR ?? settings.getSessionDir();
  const manager = options.noSession ? sdk.SessionManager.inMemory(cwd)
    : options.session ? sdk.SessionManager.open(path.resolve(cwd, options.session), sessionDir, cwd)
    : options.continue ? sdk.SessionManager.continueRecent(cwd, sessionDir) : sdk.SessionManager.create(cwd, sessionDir);
  const runner = new sdk.ExtensionRunner(active.extensions, active.runtime, cwd, manager, new sdk.ModelRegistry(models));
  const startupErrors = [];
  let ready = false, worker, session;
  const emit = (event) => { const frame = toWorkerRpcEvent(event); if (frame) publish(frame); };
  runner.onError((error) => { if (!ready) startupErrors.push(error); emit({ type: "extension_error", ...error }); });
  runner.setUIContext(broker.ui, "rpc");
  try {
    stagingBindings(runner, models);
    if (startupErrors.length) throw new Error("Extension provider registration failed");
    for (const [name, value] of options.unknownFlags) {
      const flag = runner.getFlags().get(name);
      if (!flag || typeof value !== flag.type) throw new Error(`Unknown or invalid extension flag: --${name}`);
      runner.setFlagValue(name, value);
    }
    const resolved = sdk.resolveCliModel({ cliProvider: options.provider, cliModel: options.model, modelRuntime: models });
    if (resolved.error) throw new Error(resolved.error);
    const scope = await sdk.resolveModelScopeWithDiagnostics(options.models ?? settings.getEnabledModels() ?? [], models);
    const result = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: models, settingsManager: settings,
      sessionManager: manager, resourceLoader: dormantResources(sdk, resources),
      model: resolved.model, thinkingLevel: options.thinking ?? resolved.thinkingLevel,
      scopedModels: scope.scopedModels, tools: options.tools, excludeTools: options.excludeTools,
      customTools: runner.getAllRegisteredTools().map(({ definition }) => definition),
      noTools: options.noTools ? "all" : options.noBuiltinTools ? "builtin" : undefined,
    });
    session = result.session;
    if (session.sessionManager !== manager || session.resourceLoader.getExtensions().runtime === active.runtime) {
      throw new Error("Stock SDK ownership identity mismatch");
    }
    sdk.initTheme(settings.getTheme(), false);
    const baseContext = session.extensionRunner.createCommandContext();
    broker.getTheme = () => session.extensionRunner.getUIContext().theme;
    const initialBasePromptOptions = baseContext.getSystemPromptOptions();
    const basePromptOptions = () => ({ ...initialBasePromptOptions, ...baseContext.getSystemPromptOptions(),
      cwd, customPrompt: resources.getSystemPrompt(), appendSystemPrompt: resources.getAppendSystemPrompt().join("\n\n") || undefined,
      contextFiles: resources.getAgentsFiles().agentsFiles, skills: resources.getSkills().skills,
    });
    const nativeAdapter = createNativeAdapter({ api, responsesApi, modelRuntime: models, transportOptions: { WebSocket } });
    const compactionDriver = createCompactionDriver({ sdk, core, runner, session, models, lifecycle, publish: emit });
    const navigationDriver = createNavigationDriver({ sdk, core, runner, session, models, lifecycle, publish: emit });
    const coordinator = new Coordinator({ session, sdk, api, core, models, nativeAdapter, projectContext, planRecovery, lifecycle, compactionDriver, navigationDriver,
      runner, resources, publish: emit, basePromptOptions, onTiming,
      isProjectTrusted: () => settings.isProjectTrusted() });
    worker = new SDKWorker({ session, coordinator, runner, resources, sdk, models, projectContext, broker, publish: emit, lifecycle });
    await coordinator.start();
    if (options.name !== undefined) session.setSessionName(options.name);
    await runner.emit({ type: "session_start", reason: "startup" });
    resources.extendResources(discoveredPaths(await runner.emitResourcesDiscover(cwd, "startup")));
    if (startupErrors.length) throw new Error("Extension startup failed");
    for (const message of [resolved.warning, result.modelFallbackMessage, ...scope.diagnostics.map((item) => item.message)].filter(Boolean)) {
      broker.ui.notify(message, "warning");
    }
    ready = true;
    return worker;
  } catch (error) {
    broker.close();
    if (worker) await worker.close().catch(() => {});
    else { session?.dispose(); runner.invalidate("Actor bootstrap failed"); await settings.flush(); }
    throw error;
  }
}

/** A bounded JSONL transport. UI replies bypass pending commands, including startup dialogs. */
export async function runSDKWorkerRpc({ input = process.stdin, output = process.stdout, argv = process.argv.slice(2),
  cwd = process.cwd(), env = process.env, bootstrap = bootstrapSDKWorker, installSignalHandlers = true } = {}) {
  const decoder = new PiRpcLineDecoder();
  const pending = new Set();
  const activeIds = new Set();
  let closing = false, shutdownRequested = false, drainingShutdown = false, fatalError, worker, finish, boot;
  const done = new Promise((resolve) => { finish = resolve; });
  const publish = (frame) => {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_WORKER_FRAME_BYTES + 1 || output.writableLength + Buffer.byteLength(line) > MAX_WORKER_FRAME_BYTES + 256 * 1024) {
      const error = new Error("Actor RPC output buffer limit exceeded");
      void close(error);
      throw error;
    }
    output.write(line);
  };
  const broker = new RpcDialogBroker(publish, { onChange: () => { void drainShutdown(); } });
  const lifecycle = { requestShutdown: () => { shutdownRequested = true; queueMicrotask(() => { void drainShutdown(); }); } };
  async function drainShutdown() {
    if (!shutdownRequested || closing || drainingShutdown || pending.size || broker.pendingCount) return;
    drainingShutdown = true;
    try {
      const owner = await boot;
      await owner.coordinator.waitForIdle();
      if (!pending.size && !broker.pendingCount) await close();
    } catch (error) { await close(error); }
    finally { drainingShutdown = false; }
  }
  const signals = installSignalHandlers ? ["SIGTERM", "SIGINT", ...(process.platform !== "win32" ? ["SIGHUP"] : [])] : [];
  const onSignal = () => { void close(); };
  async function close(error) {
    if (error) fatalError ??= error;
    if (closing) return done;
    closing = true;
    input.off("data", receive); input.off("end", onEnd);
    input.pause();
    broker.close();
    try { worker ??= await boot; await worker?.close(); }
    catch (failure) { fatalError ??= failure; }
    finally {
      for (const signal of signals) process.off(signal, onSignal);
      input.off("error", onError); output.off("error", onError);
      finish();
    }
    return done;
  }
  const onEnd = () => { void close(); };
  const onError = (error) => { void close(error); };
  const respondError = (command, error) => publish({ type: "response", id: command?.id, command: command?.type ?? "parse", success: false, error: errorText(error) });
  function receive(chunk) {
    if (closing) return;
    let commands;
    try { commands = decoder.push(chunk); }
    catch (error) { respondError(null, error); void close(error); return; }
    for (const command of commands) {
      if (command?.type === "extension_ui_response") { broker.respond(command); continue; }
      if (shutdownRequested) { respondError(command, new Error("Actor shutdown requested")); continue; }
      if (pending.size >= MAX_PENDING_REQUESTS) { respondError(command, new Error("Too many pending actor RPC requests")); continue; }
      if (command?.id != null && (typeof command.id !== "string" || activeIds.has(command.id))) {
        void close(new Error("Invalid or duplicate active actor RPC request id")); return;
      }
      if (command?.id != null) activeIds.add(command.id);
      const task = (async () => {
        try {
          const owner = await boot;
          if (closing) return;
          const data = await owner.handle(command);
          if (closing) return;
          publish({ type: "response", id: command?.id, command: command?.type, success: true, ...(data === undefined ? {} : { data }) });
        } catch (error) { if (!closing) respondError(command, error); }
      })();
      pending.add(task);
      task.finally(() => { pending.delete(task); activeIds.delete(command?.id); void drainShutdown(); }).catch(onError);
    }
  }
  input.on("data", receive); input.on("end", onEnd); input.on("error", onError); output.on("error", onError);
  for (const signal of signals) process.on(signal, onSignal);
  boot = bootstrap({ argv, cwd, env, publish, broker, lifecycle });
  try { worker = await boot; void drainShutdown(); }
  catch (error) { await close(error); }
  await done;
  if (fatalError) throw fatalError;
}
