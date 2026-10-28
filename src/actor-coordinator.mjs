import { ConversationBirthClock, conversationBirth } from "./conversation-birth.mjs";
import { PROGRESS_ENTRY_TYPE } from "./progress-projection.mjs";
import { normalizeInputLocation, renderUserLocations } from "./input-location.mjs";
import { renderMessageTimes } from "./message-time.mjs";
import { ActorToolDispatch, addToolUsage } from "./actor-tool-dispatch.mjs";
import { createActorStreamPlanner } from "./actor-stream.mjs";
import { evaluateInferenceRetry } from "./inference-retry.mjs";
import { fastModeOptions, streamSessionRequest, supportsFastMode } from "./fast-mode.mjs";
import { STREAM_STALL_MS, watchStreamStall } from "./stream-stall.mjs";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { TURN_FAILURE_ENTRY_TYPE, TURN_FAILURE_DIAGNOSTIC_TYPE, turnFailureErrorTokens, turnFailureSiteTokens } from "./child-turn-failure.mjs";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createOrdinaryNonAdmissionWitness, ORDINARY_NON_ADMISSION_CUSTOM_TYPE, projectCanonicalBranch, projectCanonicalContext, projectCanonicalSource, refreshCanonicalSessionContext, sessionContextInput, sessionBranchHeaders, sessionCallIssuer } from "./canonical-context.mjs";

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const clone = value => structuredClone(value);
const nativeModel = model => process.env.PI_HARNESS_NATIVE_ASYNC === "1" && model?.provider === "openai-codex"
  && model.api === "openai-codex-responses" && model.compat?.supportsAsyncTools === true;
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

// Local preparation may already have committed input or extension effects. It is
// not a provider attempt and must cross nested inference/retry catches unchanged.
class LocalPreparationError extends Error {
  constructor(stage, cause) {
    super(`${stage} preparation failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.code = "ERR_LOCAL_PREPARATION";
    this.failureClass = stage === "Prompt" ? "prompt_preparation" : "request_preparation";
  }
}

/** One actor's inference, execution, canonical writer, and public extension lifecycle owner. */
export class ActorCoordinator {
  constructor({ session, runner, sdk, api, core, models, simpleOptions, nativeAdapter, projectContext, planRecovery,
    contextMode = "array", eventMode = "full", lifecycle = {}, resources, promptCapture, publish = () => {}, basePromptOptions = {}, onTiming = () => {}, compactionDriver, navigationDriver, automaticCompactionAllowed = () => true, isProjectTrusted = () => false, streamStallMs = STREAM_STALL_MS }) {
    Object.assign(this, { session, runner, sdk, api, core, models, simpleOptions, nativeAdapter, projectContext, planRecovery,
      contextMode, eventMode, lifecycle, resources, promptCapture, publish, basePromptOptions, onTiming, compactionDriver, navigationDriver, automaticCompactionAllowed, isProjectTrusted, streamStallMs });
    this.manager = session.sessionManager;
    this.birthClock = new ConversationBirthClock();
    this.birthClock.sequence = sessionBranchHeaders(this.manager).reduce((n, entry) => Math.max(n, entry.birthSequence), 0);
    this.activeTools = new Set(); this.queue = []; this.tasks = new Map(); this.seenCalls = new Set();
    // Undelivered turn_end results belong to the logical run, not an inference flight.
    this.completedResults = [];
    this.toolTail = Promise.resolve(); this.commitTail = Promise.resolve();
    this.drivePromise = null; this.running = false; this.closed = false; this.stopping = false; this.compacting = false;
    this.controller = null; this.flight = null; this.attemptEpoch = 0; this.revision = 0; this.sentRevision = 0;
    this.continueNative = false; this.naturalStop = true; this.failure = null; this.turnIndex = 0;
    this.waiters = new Set(); this.recoveryDone = false; this.currentPrompt = session.systemPrompt; this.runPrompt = session.systemPrompt; this.serviceMutation = false;
    this.pendingInference = null;
    this.runId = null; this.runFailure = null; this.runFailureReport = null; this.runFailureEntryId = null;
    this.runProviderStarted = false; this.runToolDispatched = false;
    this.failureScopes = new AsyncLocalStorage(); this.runFailureDiagnostic = null;
    this.runResultAppended = false; this.runResultCommitFinished = false;
    this.failedAttempt = null; this.retryAttemptNumber = 1; this.retrying = false; this.overflowRecoveryAttempted = false;
    this.steeringMode = "all"; this.followUpMode = "all"; this.contextUsage = undefined;
    this.compactionHistoryBarrier = null; this.runPromptOptions = undefined;
    this.toolDispatch = new ActorToolDispatch({ runner, sdk, core, activeTools: () => this.activeTools, emit: event => this.emit(event) });
  }

  async start() {
    if (!this.promptCapture) throw new Error("a final public agent-start prompt observer is required");
    if (!this.runner) throw new Error("an independently owned public ExtensionRunner is required");
    if (this.runner === this.session.extensionRunner) throw new Error("active runner must not share the dormant SDK service runtime");
    const core = {
      sendMessage: (message, options) => { const scope = this.failureScope("async_callback", "extension_message");
        this.sendCustom(message, options).catch(error => this.fail(error, scope)); },
      sendUserMessage: (content, options = {}) => { const scope = this.failureScope("async_callback", "extension_user_input");
        this.submit(textOf(content), options.deliverAs === "followUp" ? "follow_up" : "auto",
        Array.isArray(content) ? content.filter(p => p.type === "image") : [], null, { source: "extension", expandPromptTemplates: options.expandPromptTemplates === true }).catch(error => this.fail(error, scope)); },
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
      getCallableTools: () => this.toolDispatch.callableTools(),
      executeTool: (...args) => this.toolDispatch.execute(...args),
      getModel: () => this.session.model, getScopedModels: () => this.session.scopedModels,
      isIdle: () => !this.isBusy, isProjectTrusted: () => this.isProjectTrusted(), getSignal: () => this.controller?.signal,
      abort: () => { void this.abort(); }, hasPendingMessages: () => this.queue.length > 0,
      shutdown: () => { if (this.lifecycle.requestShutdown) this.lifecycle.requestShutdown(); else void this.close(); }, getContextUsage: () => this.contextUsage,
      compact: options => { const scope = this.failureScope("async_callback", "compaction_callback");
        this.compact(options?.customInstructions).then(options?.onComplete, options?.onError ?? (error => this.fail(error, scope))); },
      getSystemPrompt: () => this.runPrompt, getSystemPromptOptions: () => this.promptOptions(),
    }, { registerProvider: (name, config) => this.models.registerProvider(name, config),
      registerNativeProvider: provider => this.models.registerNativeProvider(provider), unregisterProvider: name => this.models.unregisterProvider(name) });
    const fixedIdentity = async () => { throw new Error("actor identity replacement belongs to the supervisor"); };
    this.lifecycle.projectContext = request => {
      if (this.closed || this.stopping || !request || !["native", "ordinary"].includes(request.mode)) {
        throw new Error("canonical context is unavailable");
      }
      const entries = this.manager.getBranch(), leafId = this.manager.getLeafId();
      // Compaction hooks receive detached entries with selected signature amendments applied.
      if (request.leafId !== leafId || (!isDeepStrictEqual(request.entries, entries)
        && !isDeepStrictEqual(request.entries, projectCanonicalBranch({ entries, leafId }).entries))) {
        throw new Error("canonical context request does not match the current session branch");
      }
      return this.projectContext({ entries, leafId, mode: request.mode, buildSessionProjection: this.sdk.buildSessionProjection });
    };
    this.runner.bindCommandContext({ waitForIdle: () => this.waitForIdle(), newSession: fixedIdentity, fork: fixedIdentity,
      switchSession: fixedIdentity, reload: async () => { throw new Error("actor reload belongs to the supervisor generation lifecycle"); },
      navigateTree: (target, options = {}) => this.navigateTree(target, options) });
    this.lifecycle.onCheckpoint = (id, outcome) => {
      this.onTiming({ phase: "checkpoint_finished", at: performance.now(), toolCallId: id, ok: outcome.ok });
    };
    this.lifecycle.appendHistoryEntry = (type, data) => this.appendHistoryEntry(type, data);
  }

  async appendHistoryEntry(type, data) {
    // Bookkeeping shares the existing compaction owner. Do not move its leaf
    // while a summary is in flight; callers retain their normal delivery order.
    while (this.compactionHistoryBarrier) await this.compactionHistoryBarrier.promise;
    if (type === PROGRESS_ENTRY_TYPE) data = { ...data, harnessBirth: this.birthClock.next() };
    return this.manager.appendCustomEntry(type, data);
  }

  get isBusy() { return this.running || Boolean(this.flight) || this.tasks.size > 0 || this.compacting || this.serviceMutation; }
  baseOptions() { return clone(typeof this.basePromptOptions === "function" ? this.basePromptOptions() : this.basePromptOptions); }
  promptOptions() { return clone((this.running ? this.runPromptOptions : undefined) ?? this.baseOptions()); }
  getContextUsage() { return this.contextUsage; }
  async withServiceMutation(operation) {
    if (this.isBusy) throw new Error("service mutation requires an idle actor");
    this.serviceMutation = true;
    try { return await operation(); }
    finally { this.serviceMutation = false; this.notifyIdle(); this.wake(); }
  }
  selectInference(selection) {
    if (this.closed) throw new Error("actor is closed");
    this.pendingInference = selection;
    this.wake();
  }
  async applyPendingInference() {
    if (this.flight || this.tasks.size || this.compacting || this.serviceMutation) return;
    this.serviceMutation = true;
    try {
      while (this.pendingInference && !this.pendingInference.error) {
        const pending = this.pendingInference;
        let error = false;
        try {
          const previousModel = this.session.model, previousLevel = this.session.thinkingLevel;
          if (previousModel.provider !== pending.model.provider || previousModel.id !== pending.model.id) {
            await this.session.setModel(pending.model, { persist: false });
          }
          this.session.setThinkingLevel(pending.thinkingLevel, { persist: false });
          if (this.session.model !== previousModel) await this.runner.emit({ type: "model_select",
            model: this.session.model, previousModel, source: "set" });
          if (this.session.thinkingLevel !== previousLevel) await this.runner.emit({ type: "thinking_level_select",
            level: this.session.thinkingLevel, previousLevel });
          this.contextUsage = undefined;
          await this.lifecycle.afterCommit?.();
        } catch {
          // A failed credential check keeps the run and accepted intent intact.
          error = true; pending.error = true;
        }
        await this.publish({ type: error ? "inference_selection_failed" : "inference_selection_applied",
          requestId: pending.requestId, selection: { provider: this.session.model.provider, model: this.session.model.id,
            thinkingLevel: this.session.thinkingLevel, contextWindow: this.session.model.contextWindow,
            fastModeSupported: supportsFastMode(this.session.model) } });
        if (!error && this.pendingInference === pending) this.pendingInference = null;
      }
    } finally { this.serviceMutation = false; }
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
      messageCount: typeof this.manager.getSessionMessageCount === "function" ? this.manager.getSessionMessageCount()
        : typeof this.manager.buildSessionSource === "function" ? this.manager.buildSessionSource().length : this.manager.buildSessionProjection().messages.length,
      pendingMessageCount: this.queue.length,
      autoCompactionEnabled: this.session.autoCompactionEnabled, ...(this.failure ? { error: this.failure.message } : {}) };
  }
  async emit(event) {
    if (event.type === "message_end") throw new Error("message_end must use the canonical commit path");
    await this.runner.emit(event); await this.publish(event);
  }
  failureScope(origin, operation, { resultState } = {}) {
    return { runId: this.failureScopes.getStore()?.runId ?? this.runId, origin, operation, resultState, rejection: null };
  }
  failureObservation(error, scope) {
    return Object.freeze({ version: 1, turnId: scope.runId, ...turnFailureSiteTokens(scope.origin, scope.operation),
      ...turnFailureErrorTokens(error), resultAppended: scope.resultState?.appended ?? this.runResultAppended,
      resultCommitFinished: scope.resultState?.finished ?? this.runResultCommitFinished,
      flightPresent: Boolean(this.flight), failedAttemptPresent: Boolean(this.failedAttempt), toolWorkPresent: this.tasks.size > 0 });
  }
  rememberFailure(error, scope) {
    if (!this.running || !scope || scope.runId !== this.runId || this.runFailureDiagnostic) return;
    this.runFailureDiagnostic = scope.rejection && Object.is(scope.rejection.error, error)
      ? scope.rejection.metadata : this.failureObservation(error, scope);
  }
  async failureOperation(operation, action, { propagate = false } = {}) {
    const parent = this.failureScopes.getStore();
    if (!parent) return action();
    const scope = { ...parent, operation, rejection: null };
    return this.failureScopes.run(scope, async () => {
      try { return await action(); }
      catch (error) {
        // Only catch-free owned composition can forward a child tag. An opaque
        // callback can handle and later reuse the same thrown value internally.
        parent.rejection = propagate && scope.rejection && Object.is(scope.rejection.error, error)
          ? scope.rejection : { error, metadata: this.failureObservation(error, scope) };
        throw error;
      } finally { scope.rejection = null; }
    });
  }
  fail(error, scope = this.failureScopes.getStore()) {
    this.rememberFailure(error, scope ?? this.failureScope("async_callback", "callback"));
    this.failure = error instanceof Error ? error : new Error(String(error)); this.wake();
  }
  createTextBirth(text) {
    return (this.lifecycle.projectPublicText?.(text) ?? text).trim() ? this.birthClock.next() : undefined;
  }
  async commit(message, { immutableCalls = false, prepare, guard, onCommit } = {}) {
    const operation = this.commitTail.then(() => this.failureOperation("message_commit", async () => {
      const originalCalls = message.role === "assistant" ? JSON.stringify(message.content.filter(part => part.type === "toolCall")) : null;
      const hookInput = clone(message);
      const replacement = await this.failureOperation("message_hook", () => this.runner.emitMessageEnd({ type: "message_end", message: hookInput }));
      let final = replacement ?? hookInput;
      if (prepare) final = prepare(final).message;
      else if (final.role === "assistant") final.content = final.content.map((part, index) => {
        if (part.type !== "text") return part;
        const birth = conversationBirth(message.content[index]?.harnessBirth);
        if (Object.hasOwn(part, "harnessBirth") && !isDeepStrictEqual(part.harnessBirth, birth)) throw new Error("A message hook changed protected conversation birth metadata");
        const assigned = birth ?? this.createTextBirth(part.text);
        return assigned ? { ...part, harnessBirth: assigned } : part;
      });
      if (immutableCalls && JSON.stringify(final.content.filter(part => part.type === "toolCall")) !== originalCalls) throw new Error("a message hook changed an admitted native call");
      guard?.(final);
      const entryId = this.manager.appendMessage(final);
      if (final.role === "toolResult") {
        const scope = this.failureScopes.getStore();
        if (scope?.resultState) scope.resultState.appended = true;
        if (scope?.runId === this.runId) this.runResultAppended = true;
      }
      onCommit?.({ entryId, message: final });
      if (this.contextMode === "source") await this.failureOperation("context_refresh", () => refreshCanonicalSessionContext(this.session, this.sdk.buildSessionProjection));
      await this.failureOperation("message_publish", () => this.publish({ type: "message_end", message: final, messageId: final.id, entryId }));
      await this.failureOperation("after_commit", () => this.lifecycle.afterCommit?.());
      if (final.role === "toolResult") {
        const scope = this.failureScopes.getStore();
        if (scope?.resultState) scope.resultState.finished = true;
        if (scope?.runId === this.runId) this.runResultCommitFinished = true;
      }
      return { entryId, message: final };
    }, { propagate: true }));
    this.commitTail = operation.catch(() => {}); return operation;
  }

  async submit(message, behavior = "auto", images = [], messageId = null, { source = "rpc", expandPromptTemplates = true, location } = {}) {
    if (this.closed) throw new Error("actor is closed");
    if (typeof message !== "string") throw new Error("message must be text");
    location = normalizeInputLocation(location);
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
    this.queue.push({ kind: "user", behavior, message, images, messageId, location });
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
    const scope = this.failureScope("drive_rejection", "drive");
    scope.runId = this.runId; // A drive belongs to the actor's current run, not its caller's callback.
    this.drivePromise = this.failureScopes.run(scope, () => Promise.resolve().then(() => this.drive()).catch(async error => {
      this.rememberFailure(error, scope);
      this.failure = error;
      if (error instanceof LocalPreparationError) this.runFailure = error.failureClass;
      else if (!this.stopping && !this.controller?.signal.aborted) this.runFailure ??= "turn_failed";
      if (!(error instanceof LocalPreparationError)) return;
      // One owner terminalizes both idle and nested delivery. Stop this run even
      // if a new admission clears failure while the terminal commit is pending.
      this.failedAttempt = null; this.continueNative = false; this.stopping = true;
      this.controller?.abort();
      this.journalTurnFailure();
      const message = this.assistant([{ type: "text", text: "This turn stopped during request preparation. Inspect saved progress before continuing." }], zeroUsage(), "error");
      message.errorMessage = error.message;
      try { await this.commit(message); }
      catch (commitError) { this.failure = new AggregateError([error, commitError], `${error.message}; terminal commit failed: ${commitError.message}`); }
    }).finally(() => { scope.rejection = null; }))
      .finally(() => { this.drivePromise = null; this.notifyIdle(); if (this.shouldDrive()) this.wake(); });
  }
  shouldDrive() {
    if (this.closed || this.flight || this.compacting || this.serviceMutation) return false;
    if (this.pendingInference && !this.pendingInference.error && !this.tasks.size) return true;
    if (this.stopping) return this.running && this.tasks.size === 0;
    if (this.failure) return this.running && (this.failedAttempt !== null || this.tasks.size === 0);
    if (this.queue.some(item => item.behavior === "auto")) return !this.hasOrdinaryBarrier();
    if (this.running && (this.revision > this.sentRevision || this.continueNative)) return !this.hasOrdinaryBarrier();
    if (this.tasks.size) return false;
    return this.running || this.queue.some(item => item.behavior === "follow_up");
  }
  hasOrdinaryBarrier() { return [...this.tasks.values()].some(task => !task.native && !task.resultCommitted); }
  async deliverQueued(includeFollow = false) {
    const selected = this.queue.filter(item => item.behavior === "auto"
      || (includeFollow && item.behavior === "follow_up") || (!this.running && item.behavior === "next_turn"));
    for (const item of selected) {
      // Retain unprocessed items in their original order if commit/preparation
      // fails. Never requeue the current input after it has been committed.
      this.queue.splice(this.queue.indexOf(item), 1);
      if (item.kind === "user") {
        const content = item.images.length ? [{ type: "text", text: item.message }, ...item.images] : item.message;
        const message = { role: "user", content, timestamp: Date.now(), ...(item.location === undefined ? {} : { location: item.location }), ...(item.messageId ? { id: item.messageId } : {}) };
        await this.emit({ type: "message_start", message, messageId: message.id }); await this.commit(message);
        await this.preparePrompt(item.message, item.images);
      } else {
        const message = item.message;
        this.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        await this.lifecycle.afterCommit?.();
      }
      this.revision++; this.naturalStop = false;
    }
    return selected.length;
  }
  async preparePrompt(prompt, images) {
    try {
      const prepared = await this.promptCapture.prepare(this.runner, prompt, images, this.baseOptions());
      this.runPrompt = prepared.systemPrompt; this.runPromptOptions = clone(prepared.systemPromptOptions);
      for (const extra of prepared?.messages ?? []) this.manager.appendCustomMessageEntry(extra.customType, extra.content, extra.display, extra.details);
    } catch (error) {
      if (this.controller?.signal.aborted) throw error;
      throw new LocalPreparationError("Prompt", error);
    }
  }
  async prepareRequest() {
    try {
      return await this.lifecycle.prepareRequest?.({ systemPrompt: this.runPrompt, systemPromptOptions: this.promptOptions() }, this.runner.createContext());
    } catch (error) {
      if (this.controller?.signal.aborted) throw error;
      throw new LocalPreparationError("Request", error);
    }
  }
  async recover() {
    if (this.recoveryDone) return;
    const args = sessionContextInput(this.manager, this.sdk.buildSessionProjection, "native");
    if (this.planRecovery) for (const result of this.planRecovery({ ...args, timestamp: Date.now() })) await this.commit(result);
    for (const header of sessionBranchHeaders(this.manager)) if (header.role === "assistant") {
      // Startup only needs call identities, not historical argument/text bodies.
      for (const id of header.callIds ?? []) this.seenCalls.add(id);
    }
    this.recoveryDone = true;
  }
  async maybeAutoCompact() {
    if (!this.compactionDriver || this.flight || this.tasks.size || this.compacting || this.serviceMutation || this.failure) return false;
    const settings = this.session.settingsManager.getCompactionSettings();
    if (!settings.enabled) return false;
    if (!this.automaticCompactionAllowed("threshold", this.session.model?.contextWindow)) return false;
    const tokens = this.session.getContextUsage()?.tokens;
    if (tokens == null || !this.sdk.shouldCompact(tokens, this.session.model.contextWindow, settings)) return false;
    const entries = this.manager.getBranch();
    const latestCompaction = this.sdk.getLatestCompactionEntry(entries);
    const assistant = [...entries].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant" && !["error", "aborted"].includes(entry.message.stopReason));
    if (!assistant || (latestCompaction && assistant.message.timestamp <= Date.parse(latestCompaction.timestamp))) return false;
    try { await this.compact(undefined, { automatic: true, reason: "threshold", willRetry: false }); }
    catch (error) {
      if (error?.code === "ERR_COMPACTION_CANCELLED") return false;
      throw error;
    }
    return true;
  }
  async drive() {
    if (this.compacting || this.flight || this.closed || this.serviceMutation) return;
    await this.applyPendingInference();
    if ((this.stopping || this.failure) && this.running) {
      if (this.failure && !this.stopping && await this.recoverInference()) {
        if (this.failure) { if (!this.tasks.size && !this.failedAttempt) await this.failureOperation("settlement", () => this.settle()); return; }
      } else { if (!this.tasks.size) await this.failureOperation("settlement", () => this.settle()); return; }
    }
    if (!this.running) {
      if (!this.queue.some(item => item.behavior !== "next_turn")) return;
      this.controller = new AbortController(); this.runPrompt = this.session.systemPrompt; this.runPromptOptions = undefined; this.running = true; this.stopping = false; this.turnIndex = 0; this.retryAttemptNumber = 1; this.failedAttempt = null; this.overflowRecoveryAttempted = false;
      this.runId = randomUUID(); this.runFailure = null; this.runFailureReport = null; this.runFailureEntryId = null;
      this.runProviderStarted = false; this.runToolDispatched = false;
      this.runFailureDiagnostic = null; this.runResultAppended = false; this.runResultCommitFinished = false;
      const scope = this.failureScopes.getStore(); if (scope) scope.runId = this.runId;
      await this.failureOperation("run_start", () => this.emit({ type: "agent_start" }));
      await this.failureOperation("recovery", () => this.recover());
      await this.failureOperation("threshold_preflight", () => this.maybeAutoCompact());
    }
    while (!this.closed && !this.stopping && !this.failure) {
      if (this.hasOrdinaryBarrier()) return;
      // A completed answer admits eligible follow-ups with queued auto input.
      // Do not let auto delivery erase that boundary, or bypass unseen results.
      await this.failureOperation("queued_delivery", () => this.deliverQueued(this.naturalStop && !this.tasks.size && this.revision === this.sentRevision));
      if (this.revision > this.sentRevision || this.continueNative) {
        this.continueNative = false; await this.failureOperation("inference", () => this.inference()); await this.failureOperation("threshold_preflight", () => this.maybeAutoCompact()); continue;
      }
      if (this.tasks.size) return;
      if (this.naturalStop && await this.deliverQueued(true)) continue;
      await this.failureOperation("settlement", () => this.settle()); return;
    }
    if (!this.tasks.size && !this.failedAttempt) await this.failureOperation("settlement", () => this.settle());
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
      // Denial is terminal for this provider failure, not an ordinary retry candidate.
      if (!this.automaticCompactionAllowed("overflow", this.session.model?.contextWindow)) {
        this.failedAttempt = null; this.controller.abort(); return false;
      }
      const providerFailure = this.failure;
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
      } catch (error) {
        if (error instanceof LocalPreparationError) throw error;
        this.failure = error?.code === "ERR_COMPACTION_CANCELLED" ? providerFailure : error;
        this.failedAttempt = null; this.controller.abort(); return false;
      }
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
      if (error instanceof LocalPreparationError) throw error;
      this.failure = error; this.controller.abort(); return false;
    } finally { this.retrying = false; }
  }
  projectedSource() {
    if (this.contextMode !== "source" || this.projectContext !== projectCanonicalContext) return undefined;
    const input = sessionContextInput(this.manager, this.sdk.buildSessionProjection,
      nativeModel(this.session.model) ? "native" : "ordinary");
    if (!input.sessionManager) return undefined;
    const projection = projectCanonicalSource(input);
    const blocking = projection.diagnostics.filter(item => item.severity === "blocking");
    if (blocking.length) throw new Error(`canonical context is not ready: ${blocking.map(item => item.code).join(", ")}`);
    return projection.source;
  }
  projectedMessages() {
    const source = this.projectedSource();
    if (source) return source.readAll();
    if (!this.projectContext) return this.manager.buildSessionProjection().messages;
    const projection = this.projectContext(sessionContextInput(this.manager, this.sdk.buildSessionProjection,
      nativeModel(this.session.model) ? "native" : "ordinary"));
    const blocking = projection.diagnostics?.filter(item => item.severity === "blocking") ?? [];
    if (blocking.length) throw new Error(`canonical context is not ready: ${blocking.map(item => item.code).join(", ")}`);
    return projection.messages;
  }
  assistant(content = [], usage = zeroUsage(), stopReason = "pending") {
    const model = this.session.model;
    return { id: randomUUID(), role: "assistant", content, usage, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now() };
  }
  async inference({ reservedEpoch } = {}) {
    const runController = this.controller;
    await this.applyPendingInference();
    if (this.closed || this.stopping || runController !== this.controller || runController?.signal.aborted) return;
    const epoch = reservedEpoch ?? ++this.attemptEpoch; const requestController = new AbortController();
    const attempt = { epoch, requestId: randomUUID(), attemptId: randomUUID(), number: this.retryAttemptNumber,
      admittedCount: 0, dispatchedCount: 0, providerTools: null, retired: false, fenced: false, unstarted: new Map(), usageCommitted: false };
    const abort = () => requestController.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener("abort", abort, { once: true });
    this.flight = { ...attempt, controller: requestController, observation: attempt };
    let planner, lastTerminal, useNative, stalled = false;
    const started = new Set();
    const live = () => {
      if (epoch !== this.attemptEpoch || requestController.signal.aborted) throw new Error("retired inference attempt");
    };
    const startMessage = async message => {
      if (started.has(message.id)) return;
      started.add(message.id); await this.emit({ type: "message_start", message: clone(message), messageId: message.id });
    };
    const commitPlan = async plan => {
      let accepted = plan, calls, remainder, witnessEntryId;
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
          // Producer authority is this just-acknowledged plan and owned flight,
          // never an error string or counters recovered from a later attempt.
          if (useNative === false && this.flight?.observation === attempt && this.flight.epoch === epoch
            && epoch === this.attemptEpoch && !requestController.signal.aborted
            && accepted.kind === "final" && accepted.calls.length === 0
            && ["error", "aborted"].includes(accepted.message.stopReason)
            && accepted.message.content.some(part => part.type === "toolCall")
            && attempt.admittedCount === 0 && attempt.dispatchedCount === 0) {
            const entry = this.manager.getEntry(actual.entryId);
            const witness = entry?.id === this.manager.getLeafId() && isDeepStrictEqual(entry.message, actual.message)
              ? createOrdinaryNonAdmissionWitness(entry, attempt) : null;
            if (witness) witnessEntryId = this.manager.appendCustomEntry(ORDINARY_NON_ADMISSION_CUSTOM_TYPE, witness);
          }
        },
      });
      if (witnessEntryId) await this.publish({ type: "entry_appended", entryId: witnessEntryId });
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
      // Custom-only runs have no user admission to prepare their prompt. Run the
      // public hook once with neutral input, never as a synthetic user message.
      if (this.runPromptOptions === undefined) await this.preparePrompt("", []);
      let prompt, preparedOptions;
      do {
        preparedOptions = this.runPromptOptions;
        prompt = await this.prepareRequest();
        await this.deliverQueued(false); await this.commitTail; live();
        // Preparation may flush queued input. Re-prepare only when that delivery
        // changed the per-run prompt, before taking the matching message snapshot.
      } while (preparedOptions !== this.runPromptOptions);
      this.currentPrompt = prompt?.systemPrompt ?? this.runPrompt;
      const source = this.projectedSource();
      const messages = source ? (await this.runner.emitContextSource(source)).readAll()
        : await this.runner.emitContext(this.projectedMessages());
      live();
      this.sentRevision = this.revision;
      const tools = this.runner.getAllRegisteredTools().filter(item => this.activeTools.has(item.definition.name)).map(item => item.definition);
      useNative = nativeModel(this.session.model);
      if (useNative && !this.nativeAdapter) throw new Error("native provider adapter is not integrated in this candidate");
      const options = { ...fastModeOptions(this.session.model, prompt?.fastMode), signal: requestController.signal, reasoning: this.session.thinkingLevel === "off" ? undefined : this.session.thinkingLevel,
        sessionId: this.manager.getSessionId(), transport: this.session.settingsManager.getTransport?.(),
        onPayload: async payload => {
          live(); const result = await this.runner.emitBeforeProviderRequest(payload); live();
          attempt.providerTools = observedProviderTools(result); return result;
        },
        transformHeaders: async headers => { live(); const result = await this.runner.emitBeforeProviderHeaders(headers); live(); return result; },
        onResponse: response => epoch === this.attemptEpoch ? this.runner.emit({ type: "after_provider_response", ...response }) : undefined };
      const base = this.assistant();
      planner = createActorStreamPlanner({ message: base, createMessageId: () => randomUUID(), createTextId: () => randomUUID(),
        createTextBirth: text => this.createTextBirth(text) });
      this.flight.planner = planner;
      await this.emit({ type: "turn_start", turnIndex: this.turnIndex, timestamp: Date.now() });
      this.onTiming({ phase: "inference_start", at: performance.now(), turnIndex: this.turnIndex });
      const toolSchemas = tools.map(({ name, description, parameters, async: native, constrainedSampling }) => ({ name, description, parameters,
        ...(native ? { async: true } : {}), ...(constrainedSampling ? { constrainedSampling } : {}) }));
      const context = { systemPrompt: this.currentPrompt, messages: this.sdk.convertToLlm(renderMessageTimes(renderUserLocations(messages))), tools: toolSchemas };
      this.runProviderStarted = true;
      const stream = useNative ? this.nativeAdapter.stream(this.session.model, context, options) : streamSessionRequest(this.models, this.session.model, context, options, this);
      for await (const event of watchStreamStall(stream, this.streamStallMs, error => { stalled = true; requestController.abort(error); })) {
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
          const source = this.projectedSource();
          const tokens = (source?.estimateContextTokens?.() ?? this.core.estimateContextTokens(source ? source.readAll() : this.projectedMessages())).tokens;
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
      if (error instanceof LocalPreparationError) throw error;
      const wasAborted = requestController.signal.aborted && !stalled;
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
    const scope = this.failureScope("tool_tail_rejection", "tool_tail", { resultState: { appended: false, finished: false } });
    const run = this.toolTail.then(() => this.failureScopes.run(scope, async () => {
      let result, isError = false;
      const registered = this.runner.getAllRegisteredTools().find(item => item.definition.name === call.name && this.activeTools.has(call.name));
      const tool = registered?.definition;
      // Tool execution owns an admitted, still-pending parent. Its public session
      // view is not a provider request; ordinary replay readiness applies only
      // after the real result exists, not before dispatch can produce it.
      const messageSource = typeof this.manager.buildSessionSource === "function" ? this.manager.buildSessionSource() : undefined;
      const messages = messageSource ? undefined : this.manager.buildSessionProjection().messages;
      const issuer = sessionCallIssuer(this.manager, call.id);
      this.toolDispatch.open(call.id, executionController.signal, issuer, messages, { messageSource });
      try {
        if (executionController.signal.aborted) throw new Error("Tool cancelled before execution; it did not run.");
        if (blockedReason) throw new Error(blockedReason);
        if (!tool) throw new Error(`Unknown active tool: ${call.name}`);
        const args = this.api.validateToolArguments(tool, call);
        await this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args });
        const blocked = await this.runner.emitToolCall({ type: "tool_call", toolCallId: call.id, toolName: call.name, input: args });
        if (blocked?.block) throw new Error(blocked.reason ?? "Tool execution blocked");
        if (attempt) attempt.dispatchedCount++;
        this.runToolDispatched = true;
        this.onTiming({ phase: "tool_dispatch", at: performance.now(), toolCallId: call.id });
        result = await this.sdk.wrapRegisteredTool(registered, this.runner).execute(call.id, args, executionController.signal,
          partialResult => { const updateScope = this.failureScope("async_callback", "tool_update", { resultState: this.failureScopes.getStore()?.resultState });
            void this.emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args, partialResult }).catch(error => this.fail(error, updateScope)); });
        isError = result.isError === true;
      } catch (error) { isError = true; result = { content: [{ type: "text", text: error.message }], details: { error: error.message } }; }
      const patch = await this.runner.emitToolResult({ type: "tool_result", toolCallId: call.id, toolName: call.name, input: call.arguments,
        content: result.content, details: result.details, structuredContent: result.structuredContent, usage: result.usage, isError });
      result = { ...result, ...patch }; isError = patch?.isError ?? isError;
      if (patch?.content && patch.structuredContent === undefined) delete result.structuredContent;
      const nested = await this.toolDispatch.finish(call.id);
      await this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
      const message = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content,
        details: result.details, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(result.usage || nested.usage ? { usage: addToolUsage(result.usage, nested.usage) } : {}),
        ...(nested.nestedCalls ? { nestedCalls: nested.nestedCalls } : {}), isError, timestamp: Date.now() };
      await this.emit({ type: "message_start", message }); await this.commit(message);
      task.resultCommitted = true; this.completedResults.push(message); this.revision++;
      this.onTiming({ phase: "real_result_committed", at: performance.now(), toolCallId: call.id }); this.wake();
      // PythonKernel owns the remaining checkpoint FIFO and drains it on close/reload.
      // The real result, not later namespace durability, completes this tool call.
    }));
    this.toolTail = run.catch(error => this.fail(error, scope)).finally(() => { scope.rejection = null; this.tasks.delete(call.id); this.wake(); });
    task.promise = this.toolTail;
  }
  journalTurnFailure() {
    if (!this.runId || this.runFailureReport || !this.runFailure) return;
    // An admitted task may be paused in an awaited hook before its dispatch
    // counter advances. Freeze a conservative boundary while such work remains.
    const report = { version: 1, turnId: this.runId, failureClass: this.runFailure,
      dispatchBoundary: this.runToolDispatched || this.tasks.size > 0 ? "tool_effects_possible"
        : this.runProviderStarted ? "provider_dispatch_unknown" : "before_provider_dispatch" };
    this.runFailureEntryId = this.manager.appendCustomEntry(TURN_FAILURE_ENTRY_TYPE, report);
    this.runFailureReport = report;
    if (this.runFailureDiagnostic?.turnId === this.runId) {
      try { this.manager.appendCustomEntry(TURN_FAILURE_DIAGNOSTIC_TYPE, this.runFailureDiagnostic); }
      catch { /* Keep the original failure and its durable v1 receipt. */ }
    }
  }
  async settle() {
    if (this.tasks.size || this.flight || !this.running) return;
    await this.commitTail;
    await this.applyPendingInference();
    if (this.failure && !this.stopping) this.runFailure ??= "turn_failed";
    this.journalTurnFailure();
    // Tasks can commit after abort or an earlier turn_end. Once all run work is
    // fenced, no later turn can consume these originals; canonical clones remain.
    // Release before asynchronous end hooks, including when a hook rejects.
    this.completedResults.length = 0;
    if (this.runFailureReport) {
      // A lost report/ACK leaves the canonical marker available on registration.
      // Reporting failure must not replace the original error or replay the turn.
      try { await this.lifecycle.reportTurnFailure?.(this.runFailureReport, this.runFailureEntryId); } catch {}
    }
    if (this.contextMode === "source" && this.eventMode === "supervised-source") {
      await this.runner.emitAgentEndSource(this.manager.buildSessionSource());
      await this.publish({ type: "agent_end" });
    } else await this.emit({ type: "agent_end", messages: this.manager.buildSessionProjection().messages });
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
        if (!result.cancelled) { this.recoveryDone = false; this.seenCalls.clear(); this.contextUsage = undefined; this.birthClock.sequence = sessionBranchHeaders(this.manager).reduce((n, entry) => Math.max(n, entry.birthSequence), 0); }
        return result;
      } catch (error) {
        if (error?.committed === true) { this.recoveryDone = false; this.seenCalls.clear(); this.contextUsage = undefined; this.birthClock.sequence = sessionBranchHeaders(this.manager).reduce((n, entry) => Math.max(n, entry.birthSequence), 0); }
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
    const historyBarrier = this.compactionHistoryBarrier = Promise.withResolvers();
    if (automatic) this.runProviderStarted = true;
    try { return await this.compactionDriver({ ...options, customInstructions, automatic, coordinator: this, signal: controller.signal }); }
    catch (error) {
      // Automatic compaction runs outside inference's error commit path. Give
      // the failed turn a durable, visible error instead of silently settling.
      if (automatic && !controller.signal.aborted && error?.code !== "ERR_COMPACTION_CANCELLED") {
        this.runFailure = "compaction_failed";
        const message = this.assistant([{ type: "text", text: "This turn stopped because the conversation summary failed. Inspect saved progress before continuing." }], zeroUsage(), "error");
        message.errorMessage = `Conversation compaction failed: ${error instanceof Error ? error.message : String(error)}`;
        await this.commit(message);
      }
      throw error;
    } finally {
      this.compactionHistoryBarrier = null; historyBarrier.resolve();
      this.compacting = false; this.contextUsage = undefined; this.controller = previous; this.notifyIdle(); this.wake();
    }
  }
  async close() {
    if (this.closed) return;
    await this.abort(); this.closed = true; await this.toolTail; await this.commitTail;
    await this.runner.emit({ type: "session_shutdown", reason: "quit" }); await this.nativeAdapter?.close?.(); this.session.dispose(); this.notifyIdle();
  }
}
