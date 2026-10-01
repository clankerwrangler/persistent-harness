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

/** The existing dormant SDK service prepares, then always cancels before inference/write.
 * The active coordinator continues to own hooks, provider requests and the append.
 */
export function createCompactionPreparationCapture() {
  let receive;
  return {
    factory: pi => pi.on("session_before_compact", event => {
      try { receive?.(event.preparation); }
      finally { return { cancel: true }; } // Never fall through to a provider, even if capture fails.
    }),
    async read(session) {
      check(!receive && session.isIdle, "ERR_COMPACTION_OWNER");
      let preparation;
      receive = value => { preparation = clone(value); };
      try {
        await session.compact();
      } catch (error) {
        if (preparation) return preparation;
        if (["Already compacted", "Nothing to compact (session too small)"].includes(error?.message)) return undefined;
        throw error;
      } finally { receive = undefined; }
      throw new ActorCompactionError("ERR_COMPACTION_CAPTURE_NOT_CANCELLED");
    },
  };
}

/** A manual refresh may replace only the current summary, without discarding any
 * of its selected tail. Public projection owns the anchor; no synthetic entry or
 * persistent setting change is needed when stock cut selection has nothing new.
 */
function prepareManualRefresh(sdk, session, branchEntries, leafId) {
  const projection = sdk.buildSessionProjection(branchEntries, leafId);
  const previous = projection.entries[0]?.sourceEntry;
  const anchor = projection.entries[1]?.sourceEntry;
  if (previous?.type !== "compaction" || typeof previous.summary !== "string"
      || !previous.summary.trim() || !anchor?.id) return undefined;
  const details = !previous.fromHook && previous.details;
  const paths = value => Array.isArray(value) ? value.filter(path => typeof path === "string") : [];
  return {
    firstKeptEntryId: anchor.id, previousSummary: previous.summary,
    messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
    tokensBefore: projection.messages.reduce((sum, message) => sum + sdk.estimateTokens(message), 0),
    fileOps: { read: new Set(paths(details?.readFiles)), written: new Set(), edited: new Set(paths(details?.modifiedFiles)) },
    settings: session.settingsManager.getCompactionSettings(session.model),
  };
}

/** Stock owns edits, cut selection, usage invalidation and file tracking. Only the
 * harness's native async call/result span may require an earlier retained turn.
 */
export async function prepareActorCompaction({ sdk, session, capture, reason }) {
  const manager = session.sessionManager, leafId = manager.getLeafId();
  const original = clone(manager.getEntries());
  const { entries: branchEntries, diagnostics } = projectCanonicalBranch({ entries: original, leafId });
  const projection = projectCanonicalContext({ entries: branchEntries, leafId, buildSessionProjection: sdk.buildSessionProjection, mode: "native" });
  const outstanding = projection.outstanding;
  check(outstanding.every(call => call.retainedInContext), "ERR_COMPACTION_PENDING_ALREADY_PRUNED");
  let preparation = await capture.read(session);
  check(session.isIdle && manager.getLeafId() === leafId && isDeepStrictEqual(manager.getEntries(), original), "ERR_COMPACTION_STALE_SNAPSHOT");
  if (!preparation && reason === "manual") preparation = prepareManualRefresh(sdk, session, branchEntries, leafId);
  const base = { branchEntries, diagnostics, outstanding, preparation };
  if (!preparation) return base;
  const projected = sdk.buildSessionProjection(branchEntries, leafId).entries;
  const previous = projected.findIndex(entry => entry.sourceEntry.type === "compaction" && entry.messages.length);
  const start = previous + 1;
  const originalCut = projected.findIndex(entry => entry.sourceEntry.id === preparation.firstKeptEntryId);
  check(originalCut >= start, "ERR_COMPACTION_KEPT_ANCHOR");
  let cut = originalCut;
  const results = new Map(projected.flatMap((entry, index) => entry.messages
    .filter(message => message.role === "toolResult").map(message => [message.toolCallId, index])));
  for (let index = cut - 1; index >= start; index--) {
    const entry = projected[index];
    const calls = entry.messages.filter(message => message.role === "assistant")
      .flatMap(message => message.content.filter(block => block.type === "toolCall" && block.async === true));
    if (!calls.some(call => !results.has(call.id) || results.get(call.id) >= cut)) continue;
    let turn = index;
    while (turn > start && !sdk.convertToLlm(projected[turn].messages).some(message => message.role === "user")) turn--;
    cut = Math.min(cut, turn);
    for (const call of calls) diagnostics.push({ code: "NATIVE_CALL_RETAINED", severity: "info", toolCallId: call.id, messageEntryId: entry.sourceEntry.id });
  }
  if (cut === originalCut) return base;
  const messages = projected.slice(start, cut).filter(entry => entry.sourceEntry.type !== "compaction")
    .flatMap(entry => entry.messages.filter(message => message.role !== "system"));
  if (!messages.length) return { ...base, preparation: undefined };
  // Retaining more history does not invalidate stock's cumulative file-operation facts.
  return { ...base, preparation: { ...preparation, firstKeptEntryId: projected[cut].sourceEntry.id,
    messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false } };
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
 * This driver uses that same SessionManager; only dormant preparation calls AgentSession.compact.
 */
export function createCompactionDriver({ sdk, core, runner, session, models, capture, lifecycle = {}, publish = () => {} } = {}) {
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
      const prepared = await prepareActorCompaction({ sdk, session, capture, reason });
      sameSnapshot();
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
      finalResult.tokensBefore = prepared.preparation.tokensBefore;
      // No await between final ownership check and this single canonical append.
      sameSnapshot();
      const id = manager.appendCompaction(finalResult.summary, finalResult.firstKeptEntryId, finalResult.tokensBefore,
        finalResult.details, fromExtension, finalResult.usage);
      committed = true;
      const compactionEntry = manager.getEntry(id);
      session.agent.state.messages = projectCanonicalContext({ entries: manager.getEntries(), leafId: manager.getLeafId(),
        buildSessionProjection: sdk.buildSessionProjection, mode: "native" }).messages;
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
