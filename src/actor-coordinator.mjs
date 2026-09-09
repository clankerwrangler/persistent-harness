import { createActorStreamPlanner } from "./actor-stream.mjs";
import { evaluateInferenceRetry } from "./inference-retry.mjs";
import { estimateActorContextTokens } from "./actor-compaction.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const clone = value => structuredClone(value);
const nativeModel = model => process.env.PI_HARNESS_NATIVE_ASYNC === "1" && model?.provider === "openai-codex"
  && model.id === "gpt-6-astra" && model.api === "openai-codex-responses" && model.compat?.supportsAsyncTools === true;
const textOf = content => typeof content === "string" ? content : (content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
function observedProviderTools(payload) {
  if (!payload || typeof payload !== "object" || Object.getOwnPropertyDescriptor(payload, "toJSON")) return null;
  const descriptor = Object.getOwnPropertyDescriptor(payload, "tools");
  if (!descriptor) return false;
  if (!Object.hasOwn(descriptor, "value") || !Array.isArray(descriptor.value)) return null;
  if (Object.getOwnPropertyDescriptor(descriptor.value, "toJSON")) return null;
  for (const tool of descriptor.value) {
    if (!tool || typeof tool !== "object" || Object.getOwnPropertyDescriptor(tool, "toJSON")) return null;
    const type = Object.getOwnPropertyDescriptor(tool, "type");
    if (!type || !Object.hasOwn(type, "value") || typeof type.value !== "string") return null;
    if (!["function", "custom"].includes(type.value)) return true;
  }
  return false;
}

/** One actor's inference, execution, canonical writer, and public extension lifecycle owner. */
export class ActorCoordinator {
  constructor({ session, runner, sdk, api, core, models, nativeAdapter, projectContext, planRecovery,
    lifecycle = {}, resources, publish = () => {}, basePromptOptions = {}, onTiming = () => {}, compactionDriver, navigationDriver, isProjectTrusted = () => false }) {
    Object.assign(this, { session, runner, sdk, api, core, models, nativeAdapter, projectContext, planRecovery,
      lifecycle, resources, publish, basePromptOptions, onTiming, compactionDriver, navigationDriver, isProjectTrusted });
    this.manager = session.sessionManager;
    this.activeTools = new Set(); this.queue = []; this.tasks = new Map(); this.seenCalls = new Set();
    this.completedResults = [];
    this.toolTail = Promise.resolve(); this.commitTail = Promise.resolve();
    this.drivePromise = null; this.running = false; this.closed = false; this.stopping = false; this.compacting = false;
    this.controller = null; this.flight = null; this.attemptEpoch = 0; this.revision = 0; this.sentRevision = 0;
    this.continueNative = false; this.naturalStop = true; this.failure = null; this.turnIndex = 0;
    this.waiters = new Set(); this.recoveryDone = false; this.currentPrompt = session.systemPrompt; this.runPrompt = session.systemPrompt; this.serviceMutation = false;
    this.failedAttempt = null; this.retryAttemptNumber = 1; this.retrying = false; this.overflowRecoveryAttempted = false;
    this.steeringMode = "all"; this.followUpMode = "all"; this.contextUsage = undefined;
  }

  async start() {
    if (!this.runner) throw new Error("an independently owned public ExtensionRunner is required");
    if (this.runner === this.session.extensionRunner) throw new Error("active runner must not share the dormant SDK service runtime");
    const core = {
      sendMessage: (message, options) => { this.sendCustom(message, options).catch(error => this.fail(error)); },
      sendUserMessage: (content, options = {}) => { this.submit(textOf(content), options.deliverAs === "followUp" ? "follow_up" : "auto",
        Array.isArray(content) ? content.filter(p => p.type === "image") : [], null, { source: "extension", expandPromptTemplates: options.expandPromptTemplates === true }).catch(error => this.fail(error)); },
      appendEntry: (type, data) => { const id = this.manager.appendCustomEntry(type, data); this.publish({ type: "entry_appended", entryId: id }); },
      setSessionName: name => { this.manager.appendSessionInfo(name); void this.emit({ type: "session_info_changed", name }); },
      getSessionName: () => this.manager.getSessionName(),
      setLabel: (id, label) => this.manager.appendLabelChange(id, label),
      getActiveTools: () => [...this.activeTools],
      getAllTools: () => this.runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({ name: definition.name,
        description: definition.description, parameters: definition.parameters, promptGuidelines: definition.promptGuidelines, sourceInfo })),
      setActiveTools: names => { const known = new Set(this.runner.getAllRegisteredTools().map(t => t.definition.name)); this.activeTools = new Set(names.filter(name => known.has(name))); this.session.setActiveToolsByName([...this.activeTools]); },
      refreshTools: () => {},
      getCommands: () => this.getCommands(),
      setModel: model => this.withServiceMutation(async () => { await this.session.setModel(model, { persist: false }); await this.emit({ type: "model_select", model: this.session.model, source: "set" }); return true; }),
      getThinkingLevel: () => this.session.thinkingLevel,
      setThinkingLevel: level => { if (this.isBusy) throw new Error("thinking changes require an idle actor"); this.session.setThinkingLevel(level, { persist: false }); void this.emit({ type: "thinking_level_select", level: this.session.thinkingLevel }); },
    };
    this.runner.bindCore(core, {
      getModel: () => this.session.model, getScopedModels: () => this.session.scopedModels,
      isIdle: () => !this.isBusy, isProjectTrusted: () => this.isProjectTrusted(), getSignal: () => this.controller?.signal,
      abort: () => { void this.abort(); }, hasPendingMessages: () => this.queue.length > 0,
      shutdown: () => { if (this.lifecycle.requestShutdown) this.lifecycle.requestShutdown(); else void this.close(); }, getContextUsage: () => this.contextUsage,
      compact: options => { this.compact(options?.customInstructions).then(options?.onComplete, options?.onError ?? (error => this.fail(error))); },
      getSystemPrompt: () => this.runPrompt, getSystemPromptOptions: () => this.promptOptions(),
    }, { registerProvider: (name, config) => this.models.registerProvider(name, config),
      registerNativeProvider: provider => this.models.registerNativeProvider(provider), unregisterProvider: name => this.models.unregisterProvider(name) });
    const fixedIdentity = async () => { throw new Error("actor identity replacement belongs to the supervisor"); };
    this.runner.bindCommandContext({ waitForIdle: () => this.waitForIdle(), newSession: fixedIdentity, fork: fixedIdentity,
      switchSession: fixedIdentity, reload: async () => { throw new Error("actor reload belongs to the supervisor generation lifecycle"); },
      navigateTree: (target, options = {}) => this.navigateTree(target, options) });
    this.lifecycle.onCheckpoint = (id, outcome) => {
      this.onTiming({ phase: "checkpoint_finished", at: performance.now(), toolCallId: id, ok: outcome.ok });
    };
  }

  get isBusy() { return this.running || Boolean(this.flight) || this.tasks.size > 0 || this.compacting || this.serviceMutation; }
  promptOptions() { return clone(typeof this.basePromptOptions === "function" ? this.basePromptOptions() : this.basePromptOptions); }
  getContextUsage() { return this.contextUsage; }
  async withServiceMutation(operation) {
    if (this.isBusy) throw new Error("service mutation requires an idle actor");
    this.serviceMutation = true;
    try { return await operation(); }
    finally { this.serviceMutation = false; this.notifyIdle(); this.wake(); }
  }
  get pendingMessageCount() { return this.queue.length; }
  getCommands() {
    const extensions = this.runner.getRegisteredCommands().map(command => ({ name: command.invocationName ?? command.name,
      description: command.description, source: "extension", sourceInfo: command.sourceInfo }));
    const prompts = (this.resources?.getPrompts().prompts ?? []).map(prompt => ({ name: prompt.name, description: prompt.description,
      source: "prompt", sourceInfo: prompt.sourceInfo ?? { path: prompt.filePath, source: "prompt", scope: "temporary", origin: "top-level" } }));
    const skills = (this.resources?.getSkills().skills ?? []).map(skill => ({ name: `skill:${skill.name}`, description: skill.description,
      source: "skill", sourceInfo: skill.sourceInfo ?? { path: skill.filePath, source: "skill", scope: "temporary", origin: "top-level" } }));
    return [...extensions, ...prompts, ...skills];
  }
  getState() {
    return { model: this.session.model, thinkingLevel: this.session.thinkingLevel, isStreaming: this.isBusy,
      isCompacting: this.compacting, isRetrying: this.retrying, retryAttempt: this.retryAttemptNumber - 1, steeringMode: this.steeringMode, followUpMode: this.followUpMode,
      sessionFile: this.manager.getSessionFile(), sessionId: this.manager.getSessionId(), sessionName: this.manager.getSessionName(),
      messageCount: this.manager.buildSessionContext().messages.length, pendingMessageCount: this.queue.length,
      autoCompactionEnabled: this.session.autoCompactionEnabled, ...(this.failure ? { error: this.failure.message } : {}) };
  }
  async emit(event) {
    if (event.type === "message_end") throw new Error("message_end must use the canonical commit path");
    await this.runner.emit(event); await this.publish(event);
  }
  fail(error) { this.failure = error instanceof Error ? error : new Error(String(error)); this.wake(); }
  async commit(message, { immutableCalls = false, prepare, guard, onCommit } = {}) {
    const operation = this.commitTail.then(async () => {
      const originalCalls = message.role === "assistant" ? JSON.stringify(message.content.filter(part => part.type === "toolCall")) : null;
      const hookInput = clone(message);
      const replacement = await this.runner.emitMessageEnd({ type: "message_end", message: hookInput });
      let final = replacement ?? hookInput;
      if (prepare) final = prepare(final).message;
      if (immutableCalls && JSON.stringify(final.content.filter(part => part.type === "toolCall")) !== originalCalls) throw new Error("a message hook changed an admitted native call");
      guard?.(final);
      const entryId = this.manager.appendMessage(final);
      onCommit?.({ entryId, message: final });
      await this.publish({ type: "message_end", message: final, messageId: final.id, entryId });
      await this.lifecycle.afterCommit?.();
      return { entryId, message: final };
    });
    this.commitTail = operation.catch(() => {}); return operation;
  }

  async submit(message, behavior = "auto", images = [], messageId = null, { source = "rpc", expandPromptTemplates = true } = {}) {
    if (this.closed) throw new Error("actor is closed");
    if (typeof message !== "string") throw new Error("message must be text");
    if (behavior === "steer") behavior = "auto";
    if (behavior === "followUp") behavior = "follow_up";
    if (!["auto", "follow_up"].includes(behavior)) throw new Error("unsupported input delivery behavior");
    const matched = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (expandPromptTemplates && matched) {
      const command = this.runner.getCommand(matched[1]);
      if (command) {
        try { await command.handler(matched[2] ?? "", this.runner.createCommandContext()); }
        catch (error) { this.runner.emitError({ extensionPath: command.sourceInfo?.path ?? command.name,
          event: `command:${command.name}`, error: error instanceof Error ? error.message : String(error) }); }
        return { outcome: "handled" };
      }
    }
    const input = await this.runner.emitInput(message, images, source, this.isBusy ? behavior === "follow_up" ? "followUp" : "steer" : undefined);
    if (input.action === "handled") return { outcome: "handled" };
    if (input.action === "transform") { message = input.text; images = input.images ?? images; }
    if (expandPromptTemplates) {
      const invocation = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      if (invocation) {
        const prompt = this.resources?.getPrompts().prompts.find(item => item.name === invocation[1]);
        if (prompt) {
          if (!this.core?.formatPromptTemplateInvocation) throw new Error("public prompt-template formatter is unavailable");
          message = this.core.formatPromptTemplateInvocation(prompt, this.core.parseCommandArgs(invocation[2] ?? ""));
        } else if (invocation[1].startsWith("skill:")) {
          const skill = this.resources?.getSkills().skills.find(item => item.name === invocation[1].slice(6));
          if (skill) {
            if (!this.core?.formatSkillInvocation) throw new Error("public skill formatter is unavailable");
            message = this.core.formatSkillInvocation({ ...skill, content: await readFile(skill.filePath, "utf8") }, invocation[2]);
          }
        }
      }
    }
    this.queue.push({ kind: "user", behavior, message, images, messageId });
    this.onTiming({ phase: "input_enqueued", at: performance.now(), messageId });
    this.failure = null; this.wake(); return { outcome: "accepted" };
  }
  async sendCustom(message, { triggerTurn = false, deliverAs = "steer" } = {}) {
    if (this.closed) throw new Error("actor is closed");
    if (!this.isBusy && !triggerTurn && deliverAs !== "nextTurn") {
      this.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      await this.lifecycle.afterCommit?.(); return;
    }
    this.queue.push({ kind: "custom", behavior: deliverAs === "followUp" ? "follow_up" : deliverAs === "nextTurn" ? "next_turn" : "auto", message });
    if (triggerTurn || this.running) { this.failure = null; this.wake(); }
  }

  wake() {
    if (this.closed || this.drivePromise) return;
    this.drivePromise = Promise.resolve().then(() => this.drive()).catch(error => { this.failure = error; })
      .finally(() => { this.drivePromise = null; this.notifyIdle(); if (this.shouldDrive()) this.wake(); });
  }
  shouldDrive() {
    if (this.closed || this.flight || this.compacting || this.serviceMutation) return false;
    if (this.stopping) return this.running && this.tasks.size === 0;
    if (this.failure) return this.running && (this.failedAttempt !== null || this.tasks.size === 0);
    if (this.queue.some(item => item.behavior === "auto")) return !this.hasOrdinaryBarrier();
    if (this.running && (this.revision > this.sentRevision || this.continueNative)) return !this.hasOrdinaryBarrier();
    if (this.tasks.size) return false;
    return this.running || this.queue.some(item => item.behavior === "follow_up");
  }
  hasOrdinaryBarrier() { return [...this.tasks.values()].some(task => !task.native && !task.resultCommitted); }
  async deliverQueued(includeFollow = false) {
    const selected = []; const retained = [];
    for (const item of this.queue) {
      if (item.behavior === "auto" || (includeFollow && item.behavior === "follow_up") || (!this.running && item.behavior === "next_turn")) selected.push(item);
      else retained.push(item);
    }
    this.queue = retained;
    for (const item of selected) {
      if (item.kind === "user") {
        const content = item.images.length ? [{ type: "text", text: item.message }, ...item.images] : item.message;
        const message = { role: "user", content, timestamp: Date.now(), ...(item.messageId ? { id: item.messageId } : {}) };
        await this.emit({ type: "message_start", message, messageId: message.id }); await this.commit(message);
        const prepared = await this.runner.emitBeforeAgentStart(item.message, item.images, this.session.systemPrompt, this.promptOptions());
        this.runPrompt = prepared?.systemPrompt ?? this.session.systemPrompt;
        for (const extra of prepared?.messages ?? []) this.manager.appendCustomMessageEntry(extra.customType, extra.content, extra.display, extra.details);
      } else {
        const message = item.message;
        this.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        await this.lifecycle.afterCommit?.();
      }
      this.revision++; this.naturalStop = false;
    }
    return selected.length;
  }
  async recover() {
    if (this.recoveryDone) return;
    const args = { entries: this.manager.getEntries(), leafId: this.manager.getLeafId(), buildSessionContext: this.sdk.buildSessionContext, mode: "native" };
    if (this.planRecovery) for (const result of this.planRecovery({ ...args, timestamp: Date.now() })) await this.commit(result);
    for (const entry of this.manager.getBranch()) if (entry.type === "message" && entry.message.role === "assistant")
      for (const part of entry.message.content) if (part.type === "toolCall") this.seenCalls.add(part.id);
    this.recoveryDone = true;
  }
  async maybeAutoCompact() {
    if (!this.compactionDriver || this.flight || this.tasks.size || this.compacting || this.serviceMutation || this.failure) return false;
    const settings = this.session.settingsManager.getCompactionSettings();
    if (!settings.enabled) return false;
    const entries = this.manager.getBranch();
    const latestCompaction = this.sdk.getLatestCompactionEntry(entries);
    const assistant = [...entries].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant" && !["error", "aborted"].includes(entry.message.stopReason));
    if (!assistant || (latestCompaction && assistant.message.timestamp <= Date.parse(latestCompaction.timestamp))) return false;
    const tokens = estimateActorContextTokens({ sdk: this.sdk, core: this.core, entries: this.manager.getEntries(), leafId: this.manager.getLeafId() });
    if (!this.sdk.shouldCompact(tokens, this.session.model.contextWindow, settings)) return false;
    await this.compact(undefined, { automatic: true, reason: "threshold", willRetry: false });
    return true;
  }
  async drive() {
    if (this.compacting || this.flight || this.closed || this.serviceMutation) return;
    if ((this.stopping || this.failure) && this.running) {
      if (this.failure && !this.stopping && await this.recoverInference()) {
        if (this.failure) { if (!this.tasks.size && !this.failedAttempt) await this.settle(); return; }
      } else { if (!this.tasks.size) await this.settle(); return; }
    }
    if (!this.running) {
      if (!this.queue.some(item => item.behavior !== "next_turn")) return;
      this.controller = new AbortController(); this.runPrompt = this.session.systemPrompt; this.running = true; this.stopping = false; this.turnIndex = 0; this.retryAttemptNumber = 1; this.failedAttempt = null; this.overflowRecoveryAttempted = false;
      await this.emit({ type: "agent_start" }); await this.recover();
      await this.maybeAutoCompact();
    }
    if (this.hasOrdinaryBarrier()) return;
    await this.deliverQueued(false);
    while (!this.closed && !this.stopping && !this.failure) {
      if (this.hasOrdinaryBarrier()) return;
      if (this.revision > this.sentRevision || this.continueNative) {
        this.continueNative = false; await this.inference(); await this.maybeAutoCompact(); if (!this.hasOrdinaryBarrier()) await this.deliverQueued(false); continue;
      }
      if (this.tasks.size) return;
      if (this.naturalStop && await this.deliverQueued(true)) continue;
      await this.settle(); return;
    }
    if (!this.tasks.size && !this.failedAttempt) await this.settle();
  }

  retryObservation(attempt) {
    const report = attempt.transportReport;
    return { api: this.api, ...(report === undefined ? {} : { transportReport: report }), error: attempt.error,
      requestId: report?.requestId ?? attempt.requestId, attemptId: report?.attemptId ?? attempt.attemptId,
      attemptNumber: attempt.number, snapshotVersion: this.revision,
      policy: this.session.settingsManager.getRetrySettings(), admittedCount: attempt.admittedCount,
      dispatchedCount: attempt.dispatchedCount, providerTools: report?.providerTools ?? attempt.providerTools,
      aborted: this.stopping || this.controller.signal.aborted, retired: attempt.retired, fenced: attempt.fenced };
  }
  async recoverInference() {
    const attempt = this.failedAttempt;
    if (!attempt || this.stopping) { this.controller?.abort(); return false; }
    const overflow = this.api.isContextOverflow(attempt.terminal ?? attempt.error, this.session.model.contextWindow)
      || this.api.isRecoverableLength(attempt.terminal ?? attempt.error, this.session.model.maxTokens);
    if (overflow && this.session.settingsManager.getCompactionSettings().enabled && this.compactionDriver) {
      this.controller.abort(); await this.toolTail;
      if (this.stopping || this.closed || this.overflowRecoveryAttempted) {
        this.failedAttempt = null; return false;
      }
      this.overflowRecoveryAttempted = true;
      this.manager.appendCustomEntry("persistent-harness.compaction-recovery-v1", { version: 1, requestId: attempt.requestId,
        attemptId: attempt.attemptId, reason: "overflow", replayTools: false });
      this.failure = null; this.failedAttempt = null; this.controller = new AbortController();
      try {
        await this.compact(undefined, { automatic: true, reason: "overflow", willRetry: true });
        this.retryAttemptNumber = 1;
        const reservedEpoch = ++this.attemptEpoch;
        await this.inference({ reservedEpoch });
        return true;
      } catch (error) { this.failure = error; this.failedAttempt = null; this.controller.abort(); return false; }
    }
    const decision = evaluateInferenceRetry(this.retryObservation(attempt));
    this.manager.appendCustomEntry("persistent-harness.inference-retry-v1", decision.record);
    if (!decision.retry) { this.failedAttempt = null; this.controller.abort(); return false; }
    this.retrying = true;
    try {
      await this.emit({ type: "auto_retry_start", attempt: attempt.number, maxRetries: this.session.settingsManager.getRetrySettings().maxRetries, delayMs: decision.delayMs, errorMessage: attempt.error.errorMessage });
      await new Promise((resolve, reject) => {
        const signal = this.controller.signal;
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
        const cancel = () => { cleanup(); reject(new Error("inference retry cancelled")); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, decision.delayMs);
        if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
      });
      await this.deliverQueued(false);
      if (this.failedAttempt !== attempt || this.stopping || this.closed) return false;
      const refreshed = evaluateInferenceRetry(this.retryObservation(attempt));
      // This synchronous append + ownership transition precedes any new asynchronous preparation.
      this.manager.appendCustomEntry("persistent-harness.inference-retry-v1", refreshed.record);
      if (!refreshed.retry) { this.controller.abort(); return false; }
      this.failure = null; this.failedAttempt = null; this.retryAttemptNumber = attempt.number + 1;
      const reservedEpoch = ++this.attemptEpoch;
      await this.inference({ reservedEpoch });
      return true;
    } catch (error) {
      this.failure = error; this.controller.abort(); return false;
    } finally { this.retrying = false; }
  }
  projectedMessages() {
    if (!this.projectContext) return this.manager.buildSessionContext().messages;
    const projection = this.projectContext({ entries: this.manager.getEntries(), leafId: this.manager.getLeafId(),
      buildSessionContext: this.sdk.buildSessionContext, mode: nativeModel(this.session.model) ? "native" : "ordinary" });
    const blocking = projection.diagnostics?.filter(item => item.severity === "blocking") ?? [];
    if (blocking.length) throw new Error(`canonical context is not ready: ${blocking.map(item => item.code).join(", ")}`);
    return projection.messages;
  }
  assistant(content = [], usage = zeroUsage(), stopReason = "pending") {
    const model = this.session.model;
    return { id: randomUUID(), role: "assistant", content, usage, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now() };
  }
  async inference({ reservedEpoch } = {}) {
    const epoch = reservedEpoch ?? ++this.attemptEpoch; const requestController = new AbortController();
    const attempt = { epoch, requestId: randomUUID(), attemptId: randomUUID(), number: this.retryAttemptNumber,
      admittedCount: 0, dispatchedCount: 0, providerTools: null, retired: false, fenced: false, unstarted: new Map(), usageCommitted: false };
    const abort = () => requestController.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener("abort", abort, { once: true });
    this.flight = { ...attempt, controller: requestController, observation: attempt };
    let planner, lastTerminal;
    const started = new Set();
    const live = () => {
      if (epoch !== this.attemptEpoch || requestController.signal.aborted) throw new Error("retired inference attempt");
    };
    const startMessage = async message => {
      if (started.has(message.id)) return;
      started.add(message.id); await this.emit({ type: "message_start", message: clone(message), messageId: message.id });
    };
    const commitPlan = async plan => {
      let accepted = plan, calls, remainder;
      await startMessage(plan.message);
      const committed = await this.commit(plan.message, {
        prepare: message => {
          accepted = planner.prepareCommit({ planId: plan.planId, message });
          for (const item of accepted.calls) if (this.seenCalls.has(item.call.id)) throw new Error("duplicate canonical tool-call identity");
          return accepted;
        },
        guard: live,
        onCommit: actual => {
          attempt.admittedCount += accepted.calls.length;
          if (accepted.kind === "final") attempt.usageCommitted = true;
          const acknowledged = planner.acknowledge({ planId: accepted.planId, ...actual });
          calls = acknowledged.calls; remainder = acknowledged.remainder;
          for (const item of calls) { this.seenCalls.add(item.call.id); attempt.unstarted.set(item.call.id, item); }
        },
      });
      if (remainder && epoch === this.attemptEpoch && !requestController.signal.aborted) await startMessage(remainder);
      const nativeBatch = calls.length > 0 && calls.every(item => item.native && item.disposition === "execute");
      for (const item of calls) {
        let blocked = item.disposition === "blocked_truncated" ? "Truncated response: this tool call did not execute." : null;
        if (epoch !== this.attemptEpoch || requestController.signal.aborted) blocked = "Tool cancelled after admission; it did not run.";
        this.scheduleTool(item.call, nativeBatch, blocked, attempt, { admitted: true });
        attempt.unstarted.delete(item.call.id);
      }
      return { committed, calls, nativeBatch };
    };
    try {
      const prompt = await this.lifecycle.prepareRequest?.({ systemPrompt: this.runPrompt, systemPromptOptions: this.promptOptions() }, this.runner.createContext());
      this.currentPrompt = prompt?.systemPrompt ?? this.runPrompt;
      await this.deliverQueued(false); await this.commitTail; live();
      let messages = this.projectedMessages(); messages = await this.runner.emitContext(messages); live();
      this.sentRevision = this.revision;
      const tools = this.runner.getAllRegisteredTools().filter(item => this.activeTools.has(item.definition.name)).map(item => item.definition);
      const useNative = nativeModel(this.session.model);
      if (useNative && !this.nativeAdapter) throw new Error("native provider adapter is not integrated in this candidate");
      const options = { signal: requestController.signal, reasoning: this.session.thinkingLevel === "off" ? undefined : this.session.thinkingLevel,
        sessionId: this.manager.getSessionId(), transport: this.session.settingsManager.getTransport?.(),
        onPayload: async payload => {
          live(); const result = await this.runner.emitBeforeProviderRequest(payload); live();
          attempt.providerTools = observedProviderTools(result); return result;
        },
        transformHeaders: async headers => { live(); const result = await this.runner.emitBeforeProviderHeaders(headers); live(); return result; },
        onResponse: response => epoch === this.attemptEpoch ? this.runner.emit({ type: "after_provider_response", ...response }) : undefined };
      const base = this.assistant();
      planner = createActorStreamPlanner({ message: base, createMessageId: () => randomUUID(), createTextId: () => randomUUID() });
      this.flight.planner = planner;
      await this.emit({ type: "turn_start", turnIndex: this.turnIndex, timestamp: Date.now() });
      this.onTiming({ phase: "inference_start", at: performance.now(), turnIndex: this.turnIndex });
      const toolSchemas = tools.map(({ name, description, parameters, async: native, constrainedSampling }) => ({ name, description, parameters,
        ...(native ? { async: true } : {}), ...(constrainedSampling ? { constrainedSampling } : {}) }));
      const context = { systemPrompt: this.currentPrompt, messages: this.sdk.convertToLlm(messages), tools: toolSchemas };
      const stream = useNative ? this.nativeAdapter.stream(this.session.model, context, options) : this.models.streamSimple(this.session.model, context, options);
      for await (const event of stream) {
        live();
        if (event.type === "done" || event.type === "error") lastTerminal = event.message ?? event.error;
        const candidateProof = useNative ? this.nativeAdapter.nativeCompletion(event) : null;
        const proof = candidateProof && tools.some(tool => tool.name === candidateProof.call?.name && tool.async === true) ? candidateProof : null;
        const step = planner.consume(event, proof);
        if (step.update) {
          await startMessage(step.update.message);
          if (step.update.assistantMessageEvent.type !== "start") await this.emit({ type: "message_update", message: clone(step.update.message),
            messageId: step.update.message.id, assistantMessageEvent: clone(step.update.assistantMessageEvent) });
        }
        if (step.prefix) await commitPlan(step.prefix);
        for (const amendment of step.amendments) {
          live(); const entryId = this.manager.appendCustomEntry(amendment.customType, amendment.data);
          await this.publish({ type: "entry_appended", entryId });
        }
        if (step.final) {
          const { committed, calls, nativeBatch } = await commitPlan(step.final);
          const final = committed.message;
          if (calls.length && !nativeBatch) await this.toolTail;
          const tokens = this.core.estimateContextTokens(this.projectedMessages()).tokens;
          this.contextUsage = { tokens, contextWindow: this.session.model.contextWindow, percent: tokens / this.session.model.contextWindow * 100 };
          this.naturalStop = final.stopReason === "stop" && !final.content.some(part => part.type === "toolCall");
          this.continueNative = false;
          await this.emit({ type: "turn_end", turnIndex: this.turnIndex++, message: final, toolResults: this.completedResults.splice(0) });
          if (event.type === "error" || this.api.isRecoverableLength(final, this.session.model.maxTokens)) throw Object.assign(new Error(final.errorMessage ?? "provider output was truncated"), { providerEvent: event, alreadyCommitted: true });
          this.overflowRecoveryAttempted = false;
          if (attempt.number > 1) await this.emit({ type: "auto_retry_end", success: true, attempt: attempt.number - 1 });
          this.retryAttemptNumber = 1;
        }
      }
    } catch (error) {
      const wasAborted = requestController.signal.aborted;
      this.failure = error;
      const terminal = error.providerEvent?.error ?? lastTerminal;
      const message = this.assistant([], attempt.usageCommitted ? zeroUsage() : clone(terminal?.usage ?? zeroUsage()), wasAborted ? "aborted" : "error");
      message.errorMessage = error.message;
      attempt.error = { stopReason: message.stopReason, errorMessage: message.errorMessage };
      attempt.terminal = terminal ? clone(terminal) : clone(attempt.error);
      attempt.transportReport = terminal?.nativeTransport;
      if (attempt.transportReport) message.nativeTransport = clone(attempt.transportReport);
      this.failedAttempt = attempt;
      for (const item of attempt.unstarted.values()) this.scheduleTool(item.call, false, "Canonical admission did not reach execution; this call did not run.", attempt, { admitted: true });
      attempt.unstarted.clear();
      if (!error.alreadyCommitted) await this.commit(message);
    } finally {
      planner?.cancel();
      this.controller?.signal.removeEventListener("abort", abort);
      if (attempt.error) requestController.abort();
      attempt.retired = true; attempt.fenced = true;
      if (this.flight?.epoch === epoch) this.flight = null;
    }
  }

  scheduleTool(call, native, blockedReason = null, attempt = null, { admitted = false } = {}) {
    if (!admitted) {
      if (this.seenCalls.has(call.id)) throw new Error("duplicate canonical tool-call identity");
      this.seenCalls.add(call.id); if (attempt) attempt.admittedCount++;
    } else if (!this.seenCalls.has(call.id) || this.tasks.has(call.id)) throw new Error("invalid admitted tool dispatch");
    const executionController = this.controller;
    const task = { call: clone(call), native, resultCommitted: false }; this.tasks.set(call.id, task);
    const run = this.toolTail.then(async () => {
      let result, isError = false;
      const registered = this.runner.getAllRegisteredTools().find(item => item.definition.name === call.name && this.activeTools.has(call.name));
      const tool = registered?.definition;
      try {
        if (executionController.signal.aborted) throw new Error("Tool cancelled before execution; it did not run.");
        if (blockedReason) throw new Error(blockedReason);
        if (!tool) throw new Error(`Unknown active tool: ${call.name}`);
        const args = this.api.validateToolArguments(tool, call);
        await this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args });
        const blocked = await this.runner.emitToolCall({ type: "tool_call", toolCallId: call.id, toolName: call.name, input: args });
        if (blocked?.block) throw new Error(blocked.reason ?? "Tool execution blocked");
        if (attempt) attempt.dispatchedCount++;
        this.onTiming({ phase: "tool_dispatch", at: performance.now(), toolCallId: call.id });
        result = await tool.execute(call.id, args, executionController.signal,
          partialResult => { void this.emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args, partialResult }).catch(error => this.fail(error)); },
          this.runner.createContext());
      } catch (error) { isError = true; result = { content: [{ type: "text", text: error.message }], details: { error: error.message } }; }
      const patch = await this.runner.emitToolResult({ type: "tool_result", toolCallId: call.id, toolName: call.name, input: call.arguments,
        content: result.content, details: result.details, usage: result.usage, isError });
      result = { ...result, ...patch }; isError = patch?.isError ?? isError;
      await this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
      const message = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content,
        details: result.details, ...(result.usage ? { usage: result.usage } : {}), isError, timestamp: Date.now() };
      await this.emit({ type: "message_start", message }); await this.commit(message);
      task.resultCommitted = true; this.completedResults.push(message); this.revision++;
      this.onTiming({ phase: "real_result_committed", at: performance.now(), toolCallId: call.id }); this.wake();
      // PythonKernel owns the remaining checkpoint FIFO and drains it on close/reload.
      // The real result, not later namespace durability, completes this tool call.
    });
    this.toolTail = run.catch(error => this.fail(error)).finally(() => { this.tasks.delete(call.id); this.wake(); });
    task.promise = this.toolTail;
  }
  async settle() {
    if (this.tasks.size || this.flight || !this.running) return;
    await this.commitTail;
    await this.emit({ type: "agent_end", messages: this.manager.buildSessionContext().messages });
    this.running = false; this.stopping = false;
    await this.emit({ type: "agent_settled" }); this.notifyIdle();
  }
  async waitForIdle() { if (!this.isBusy && !this.drivePromise && !this.shouldDrive()) return; const waiter = Promise.withResolvers(); this.waiters.add(waiter); await waiter.promise; }
  notifyIdle() { if (!this.isBusy && !this.drivePromise && !this.shouldDrive()) { for (const waiter of this.waiters) waiter.resolve(); this.waiters.clear(); } }
  async abort() {
    this.stopping = true; this.controller?.abort(); this.flight?.controller.abort(); this.attemptEpoch++;
    this.continueNative = false; this.wake(); await this.waitForIdle();
  }
  async navigateTree(target, options = {}) {
    if (!this.navigationDriver) throw new Error("stock candidate navigation driver is not ready");
    return this.withServiceMutation(async () => {
      const previous = this.controller; const controller = new AbortController(); this.controller = controller;
      try {
        const result = await this.navigationDriver(target, options, { coordinator: this, signal: controller.signal });
        if (!result.cancelled) { this.recoveryDone = false; this.seenCalls.clear(); this.contextUsage = undefined; }
        return result;
      } catch (error) {
        if (error?.committed === true) { this.recoveryDone = false; this.seenCalls.clear(); this.contextUsage = undefined; }
        throw error;
      } finally { this.controller = previous; }
    });
  }
  async compact(customInstructions, options = {}) {
    const automatic = options.automatic === true;
    if (automatic ? (this.flight || this.tasks.size || this.serviceMutation || this.compacting) : this.isBusy) throw new Error("compaction requires settled tool results and no provider flight");
    if (!this.compactionDriver) throw new Error("stock candidate compaction ownership integration is not complete");
    const previous = this.controller;
    const controller = automatic && previous && !previous.signal.aborted ? previous : new AbortController();
    this.controller = controller; this.compacting = true;
    try { return await this.compactionDriver({ ...options, customInstructions, automatic, coordinator: this, signal: controller.signal }); }
    finally { this.compacting = false; this.contextUsage = undefined; this.controller = previous; this.notifyIdle(); this.wake(); }
  }
  async close() {
    if (this.closed) return;
    await this.abort(); this.closed = true; await this.toolTail; await this.commitTail;
    await this.runner.emit({ type: "session_shutdown", reason: "quit" }); await this.nativeAdapter?.close?.(); this.session.dispose(); this.notifyIdle();
  }
}
