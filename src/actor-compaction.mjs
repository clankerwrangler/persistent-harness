import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { projectCanonicalBranch, projectCanonicalContext } from "./canonical-context.mjs";

export class ActorCompactionError extends Error {
  constructor(code, message = code, options) {
    super(message, options); this.name = "ActorCompactionError"; this.code = code;
  }
}
const check = (condition, code) => { if (!condition) throw new ActorCompactionError(code); };
const clone = value => structuredClone(value);
const abort = signal => { if (signal?.aborted) throw new ActorCompactionError("ERR_COMPACTION_ABORTED", "Compaction aborted"); };
const finite = value => Number.isFinite(value) && value >= 0;

function validateSettings(settings) {
  check(settings && typeof settings.enabled === "boolean", "ERR_COMPACTION_SETTINGS");
  for (const key of ["reserveTokens", "keepRecentTokens"])
    check(Number.isSafeInteger(settings[key]) && settings[key] >= 0 && settings[key] <= 1_000_000_000, "ERR_COMPACTION_SETTINGS");
  return { enabled: settings.enabled, reserveTokens: settings.reserveTokens, keepRecentTokens: settings.keepRecentTokens };
}

// The public core estimate accepts the same AgentMessage union; no Entry or retainedTail adapter.
export function estimateActorContextTokens({ sdk, core, entries, leafId }) {
  const projection = projectCanonicalContext({ entries, leafId, buildSessionContext: sdk.buildSessionContext, mode: "native" });
  const tokens = core.estimateContextTokens(projection.messages).tokens;
  check(finite(tokens), "ERR_COMPACTION_TOKEN_ESTIMATE");
  return tokens;
}

function fileOperations(previous, messages) {
  const fileOps = { read: new Set(), written: new Set(), edited: new Set() };
  if (previous && !previous.fromHook) {
    for (const [key, target] of [["readFiles", "read"], ["modifiedFiles", "edited"]]) {
      const paths = previous.details?.[key];
      if (Array.isArray(paths)) for (const path of paths) if (typeof path === "string") fileOps[target].add(path);
    }
  }
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const target = { read: "read", write: "written", edit: "edited" }[block.name];
      const path = block.arguments?.path ?? block.arguments?.file_path;
      if (target && typeof path === "string") fileOps[target].add(path);
    }
  }
  return fileOps;
}

/** Original firstKeptEntryId adapter composed from public coding SDK helpers.
 * No private prepareCompaction, synthetic entries, parent rewrites, or tool execution.
 */
export function prepareActorCompaction({ sdk, core, entries, leafId, settings }) {
  settings = validateSettings(settings);
  const { entries: branchEntries, diagnostics } = projectCanonicalBranch({ entries, leafId });
  const projection = projectCanonicalContext({ entries: branchEntries, leafId, buildSessionContext: sdk.buildSessionContext, mode: "native" });
  const outstanding = projection.outstanding;
  check(outstanding.every(call => call.retainedInContext), "ERR_COMPACTION_PENDING_ALREADY_PRUNED");
  const previous = sdk.getLatestCompactionEntry(branchEntries);
  const start = previous ? branchEntries.findIndex(entry => entry.id === previous.firstKeptEntryId) : 0;
  const base = { branchEntries, diagnostics, outstanding };
  if (!branchEntries.length || branchEntries.at(-1)?.type === "compaction") return { ...base, preparation: undefined };
  check(start >= 0, "ERR_COMPACTION_KEPT_ANCHOR");
  const originalCut = sdk.findCutPoint(branchEntries, start, branchEntries.length, settings.keepRecentTokens);
  let cut = originalCut.firstKeptEntryIndex;
  const activeIds = new Set(sdk.buildContextEntries(branchEntries, leafId).map(entry => entry.id));
  const calls = new Map(), results = new Map();
  branchEntries.forEach((entry, index) => {
    if (entry.type !== "message") return;
    if (entry.message.role === "assistant") for (const block of entry.message.content)
      if (block.type === "toolCall" && block.async === true) calls.set(block.id, { index, entryId: entry.id });
    if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, index);
  });
  // Reverse traversal reaches each earlier call after any rightward pair has moved
  // the cut back. This pins pending calls defensively and keeps resolved pairs intact.
  for (const [id, call] of [...calls].reverse()) {
    if (call.index >= cut || !activeIds.has(call.entryId)) continue;
    if (!results.has(id) || results.get(id) >= cut) {
      const turn = sdk.findTurnStartIndex(branchEntries, call.index, start);
      const next = turn >= start ? turn : call.index;
      diagnostics.push({ code: "NATIVE_CALL_RETAINED", severity: "info", toolCallId: id, messageEntryId: call.entryId });
      cut = Math.min(cut, next);
    }
  }
  if (cut <= start || cut >= branchEntries.length) return { ...base, preparation: undefined };
  const first = branchEntries[cut];
  const firstMessage = sdk.sessionEntryToContextMessages(first)[0];
  const turn = sdk.findTurnStartIndex(branchEntries, cut, start);
  const isSplitTurn = cut === originalCut.firstKeptEntryIndex ? originalCut.isSplitTurn
    : firstMessage?.role !== "user" && turn >= start;
  const prefixStart = isSplitTurn && turn >= start ? turn : cut;
  const messages = (from, to) => branchEntries.slice(from, to).filter(entry => entry.type !== "compaction")
    .flatMap(entry => sdk.sessionEntryToContextMessages(entry));
  const messagesToSummarize = messages(start, prefixStart);
  const turnPrefixMessages = isSplitTurn ? messages(prefixStart, cut) : [];
  if (!messagesToSummarize.length && !turnPrefixMessages.length) return { ...base, preparation: undefined };
  const preparation = {
    firstKeptEntryId: first.id, messagesToSummarize, turnPrefixMessages, isSplitTurn,
    tokensBefore: estimateActorContextTokens({ sdk, core, entries: branchEntries, leafId }),
    previousSummary: previous?.summary,
    fileOps: fileOperations(previous, [...messagesToSummarize, ...turnPrefixMessages]), settings,
  };
  return { ...base, preparation };
}

function validateResult(result, prepared, sdk) {
  // Validate before reading any extension-controlled property (including accessors).
  const probe = { type: "custom", id: "compaction-output-validation", parentId: null, data: result };
  result = projectCanonicalBranch({ entries: [probe], leafId: probe.id }).entries[0].data;
  check(result && typeof result.summary === "string" && result.summary.trim().length > 0
    && result.summary.length <= 16 * 1024 * 1024, "ERR_COMPACTION_RESULT");
  check(finite(result.tokensBefore), "ERR_COMPACTION_RESULT");
  const active = sdk.buildContextEntries(prepared.branchEntries, prepared.branchEntries.at(-1)?.id ?? null);
  const kept = active.findIndex(entry => entry.id === result.firstKeptEntryId);
  check(kept >= 0, "ERR_COMPACTION_RESULT_ANCHOR");
  const keptIds = new Set(active.slice(kept).map(entry => entry.id));
  for (const call of prepared.outstanding) check(keptIds.has(call.messageEntryId), "ERR_COMPACTION_RESULT_PRUNES_PENDING");
  return result;
}

/** The caller holds the sole coordinator service lease through this whole operation.
 * This driver uses that same SessionManager and never calls AgentSession.compact.
 */
export function createCompactionDriver({ sdk, core, runner, session, models, lifecycle = {}, publish = () => {} } = {}) {
  check(session?.sessionManager && runner && runner !== session.extensionRunner, "ERR_COMPACTION_OWNER");
  const manager = session.sessionManager;
  return async ({ customInstructions, automatic = false, reason = automatic ? "threshold" : "manual", willRetry = false,
    coordinator, signal } = {}) => {
    check(["manual", "threshold", "overflow"].includes(reason) && typeof willRetry === "boolean", "ERR_COMPACTION_REASON");
    check(coordinator?.manager === manager && coordinator.session === session, "ERR_COMPACTION_OWNER");
    check(signal && typeof signal.aborted === "boolean", "ERR_COMPACTION_SIGNAL");
    check(customInstructions === undefined || typeof customInstructions === "string" && customInstructions.length <= 4 * 1024 * 1024,
      "ERR_COMPACTION_INSTRUCTIONS");
    const callerSignal = signal;
    const localController = new AbortController();
    signal = AbortSignal.any([callerSignal, localController.signal]);
    const completions = [], dispatches = [];
    let providerTail = Promise.resolve(), streamFailure;
    const sessionId = manager.getSessionId(), leafId = manager.getLeafId();
    const original = clone(manager.getEntries());
    const sameSnapshot = () => {
      abort(signal);
      check(session.isIdle && manager.getSessionId() === sessionId && manager.getLeafId() === leafId
        && isDeepStrictEqual(manager.getEntries(), original), "ERR_COMPACTION_STALE_SNAPSHOT");
    };
    let fromExtension = false, committed = false, finalResult, terminalAttempted = false;
    await publish({ type: "compaction_start", reason });
    try {
      sameSnapshot();
      check(session.model, "ERR_COMPACTION_MODEL");
      const prepared = prepareActorCompaction({ sdk, core, entries: original, leafId,
        settings: session.settingsManager.getCompactionSettings() });
      check(prepared.outstanding.length === 0, "ERR_COMPACTION_PENDING_CALLS");
      check(prepared.preparation, "ERR_COMPACTION_NOTHING_TO_SUMMARIZE");
      const event = { type: "session_before_compact", preparation: clone(prepared.preparation),
        branchEntries: clone(prepared.branchEntries), customInstructions, reason, willRetry, signal };
      const diagnostic = await lifecycle.prepareCompaction?.(event, runner.createContext());
      if (diagnostic?.customInstructions !== undefined) {
        check(typeof diagnostic.customInstructions === "string" && diagnostic.customInstructions.length <= 4 * 1024 * 1024,
          "ERR_COMPACTION_INSTRUCTIONS");
        event.customInstructions = diagnostic.customInstructions;
      }
      sameSnapshot();
      const custom = await runner.emit(event);
      sameSnapshot();
      if (custom?.cancel) throw new ActorCompactionError("ERR_COMPACTION_CANCELLED", "Compaction cancelled");
      let result;
      if (custom?.compaction) { fromExtension = true; result = custom.compaction; }
      else {
        // Public StreamFn permits a Promise<AssistantMessageEventStream>. Queue starts,
        // not events: return each actual provider stream unchanged, never a fake result.
        const stream = (model, context, options) => {
          const previous = providerTail;
          let release;
          providerTail = new Promise(resolve => { release = resolve; });
          const dispatch = (async () => {
            await previous;
            abort(signal);
            const request = event.customInstructions ? { ...context, messages: [...context.messages,
              { role: "user", content: event.customInstructions, timestamp: Date.now() }] } : context;
            const response = models.streamSimple(model, request, { ...options,
              onPayload: payload => runner.emitBeforeProviderRequest(payload),
              transformHeaders: headers => runner.emitBeforeProviderHeaders(headers),
              onResponse: response => runner.emit({ type: "after_provider_response", ...response }),
            });
            const completed = response.result().then(message => {
              if (message.stopReason === "aborted" || message.stopReason === "length") {
                streamFailure ??= new ActorCompactionError(message.stopReason === "aborted"
                  ? "ERR_COMPACTION_ABORTED" : "ERR_COMPACTION_SUMMARY_LENGTH",
                message.stopReason === "aborted" ? "Compaction provider aborted" : "Compaction summary exceeded the output limit");
                localController.abort();
              }
              return { message };
            }, error => {
              streamFailure ??= new ActorCompactionError("ERR_COMPACTION_STREAM_FAILED", "Compaction stream failed", { cause: error });
              localController.abort();
              return { error };
            });
            completions.push(completed);
            // Let STOCK classify a terminal error before another queued summary starts.
            // A final rejection aborts the queue; retry backoff may yield to another summary.
            void completed.then(() => setImmediate(release));
            return response;
          })().catch(error => {
            streamFailure ??= error;
            localController.abort();
            release();
            throw error;
          });
          dispatches.push(dispatch.then(() => undefined, () => undefined));
          return dispatch;
        };
        result = await sdk.compact(clone(prepared.preparation), session.model, undefined, undefined,
          event.customInstructions, signal, session.thinkingLevel, stream, undefined,
          session.settingsManager.getRetrySettings(), {
            onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => publish({ type: "summarization_retry_scheduled", attempt, maxAttempts, delayMs, errorMessage }),
            onRetryAttemptStart: () => publish({ type: "summarization_retry_attempt_start", source: "compaction", reason }),
            onRetryFinished: () => publish({ type: "summarization_retry_finished" }),
          }, randomUUID());
        const completed = await Promise.all(completions);
        check(!completed.some(value => value.error), "ERR_COMPACTION_STREAM_FAILED");
        if (completed.some(value => value.message?.stopReason === "aborted"))
          throw new ActorCompactionError("ERR_COMPACTION_ABORTED", "Compaction provider aborted");
      }
      sameSnapshot();
      finalResult = validateResult(result, prepared, sdk);
      finalResult.tokensBefore = estimateActorContextTokens({ sdk, core, entries: original, leafId });
      // No await between final ownership check and this single canonical append.
      sameSnapshot();
      const id = manager.appendCompaction(finalResult.summary, finalResult.firstKeptEntryId, finalResult.tokensBefore,
        finalResult.details, fromExtension, finalResult.usage);
      committed = true;
      const compactionEntry = manager.getEntry(id);
      session.agent.state.messages = projectCanonicalContext({ entries: manager.getEntries(), leafId: manager.getLeafId(),
        buildSessionContext: sdk.buildSessionContext, mode: "native" }).messages;
      await publish({ type: "entry_appended", entry: compactionEntry });
      await runner.emit({ type: "session_compact", compactionEntry, fromExtension, reason, willRetry });
      await lifecycle.afterCommit?.();
      terminalAttempted = true;
      await publish({ type: "compaction_end", reason, result: finalResult, aborted: false, willRetry });
      return finalResult;
    } catch (error) {
      error = streamFailure ?? error;
      const aborted = callerSignal.aborted || error?.code === "ERR_COMPACTION_CANCELLED" || error?.code === "ERR_COMPACTION_ABORTED";
      localController.abort();
      // STOCK split summaries run concurrently. Drain both public streams before releasing the owner's lease.
      await Promise.all(dispatches);
      await Promise.all(completions);
      if (committed) {
        // Never retry an append or an uncertain notification after a committed write.
        if (!terminalAttempted) {
          terminalAttempted = true;
          try { await publish({ type: "compaction_end", reason, result: finalResult, aborted: false, willRetry }); }
          catch { /* Original post-commit failure remains the cause; no second dispatch. */ }
        }
        const failure = new ActorCompactionError("ERR_COMPACTION_COMMITTED", "Compaction committed; post-commit notification failed", { cause: error });
        failure.committed = true;
        failure.result = finalResult;
        throw failure;
      }
      const errorMessage = aborted ? undefined : error instanceof Error ? error.message : String(error);
      await publish({ type: "compaction_end", reason, result: undefined, aborted, willRetry, ...(errorMessage ? { errorMessage } : {}) });
      await runner.emit({ type: "session_compact_failed", reason, aborted, willRetry, fromExtension, ...(errorMessage ? { errorMessage } : {}) });
      throw error;
    }
  };
}
