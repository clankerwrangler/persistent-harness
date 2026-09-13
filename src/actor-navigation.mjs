import { isDeepStrictEqual } from "node:util";
import { projectCanonicalBranch, projectCanonicalContext } from "./canonical-context.mjs";

export class ActorNavigationError extends Error {
  constructor(code, message = code, options) { super(message, options); this.name = "ActorNavigationError"; this.code = code; }
}
const check = (condition, code) => { if (!condition) throw new ActorNavigationError(code); };
const clone = value => structuredClone(value);
const boundedText = value => value === undefined || typeof value === "string" && value.length <= 4 * 1024 * 1024;
function checkedOptions(options) {
  check(options && typeof options === "object" && !Array.isArray(options), "ERR_NAVIGATION_OPTIONS");
  const { summarize, customInstructions, replaceInstructions, label } = options;
  check(summarize === undefined || typeof summarize === "boolean", "ERR_NAVIGATION_OPTIONS");
  check(replaceInstructions === undefined || typeof replaceInstructions === "boolean", "ERR_NAVIGATION_OPTIONS");
  check(boundedText(customInstructions) && boundedText(label), "ERR_NAVIGATION_OPTIONS");
  return { summarize, customInstructions, replaceInstructions, label };
}

/** Compose preparation from the public stock collection helper, not private session preparation. */
export function prepareActorNavigation({ sdk, manager, targetId, options = {} }) {
  options = checkedOptions(options);
  check(typeof targetId === "string" && targetId.length > 0 && targetId.length <= 1024, "ERR_NAVIGATION_TARGET");
  const oldLeafId = manager.getLeafId();
  if (targetId === oldLeafId) return undefined;
  const target = manager.getEntry(targetId);
  check(target, "ERR_NAVIGATION_TARGET");
  const { entries, commonAncestorId } = sdk.collectEntriesForBranchSummary(manager, oldLeafId, targetId);
  const isInput = target.type === "custom_message" || target.type === "message" && target.message.role === "user";
  const content = target.type === "custom_message" ? target.content : target.message?.content;
  const editorText = isInput ? typeof content === "string" ? content
    : content.filter(part => part.type === "text").map(part => part.text).join("") : undefined;
  return { newLeafId: isInput ? target.parentId : targetId, editorText,
    preparation: { targetId, oldLeafId, commonAncestorId, entriesToSummarize: clone(entries),
      userWantsSummary: options.summarize ?? false, customInstructions: options.customInstructions,
      replaceInstructions: options.replaceInstructions, label: options.label } };
}

function checkedResult(value) {
  // Reject accessors and non-JSON extension data before reading the supplied result.
  const probe = { type: "custom", id: "navigation-output-validation", parentId: null, data: value };
  const result = projectCanonicalBranch({ entries: [probe], leafId: probe.id }).entries[0].data;
  check(result && typeof result.summary === "string" && result.summary.length <= 16 * 1024 * 1024, "ERR_NAVIGATION_SUMMARY");
  return result;
}

/** Caller holds the coordinator service lease until summaries and notifications finish. */
export function createNavigationDriver({ sdk, core, runner, session, models, lifecycle = {}, publish = () => {} } = {}) {
  check(session?.sessionManager && runner && runner !== session.extensionRunner, "ERR_NAVIGATION_OWNER");
  const manager = session.sessionManager;
  return async (targetId, options = {}, { coordinator, signal } = {}) => {
    check(coordinator?.manager === manager && coordinator.session === session && coordinator.serviceMutation === true,
      "ERR_NAVIGATION_OWNER");
    check(signal && typeof signal.aborted === "boolean", "ERR_NAVIGATION_SIGNAL");
    options = checkedOptions(options);
    const sessionId = manager.getSessionId(), oldLeafId = manager.getLeafId(), original = clone(manager.getEntries());
    const streams = [];
    let committed = false, outcome;
    const sameSnapshot = () => {
      if (signal.aborted) throw new ActorNavigationError("ERR_NAVIGATION_ABORTED");
      check(session.isIdle && coordinator.serviceMutation === true && manager.getSessionId() === sessionId
        && manager.getLeafId() === oldLeafId && isDeepStrictEqual(manager.getEntries(), original), "ERR_NAVIGATION_STALE_SNAPSHOT");
    };
    try {
      sameSnapshot();
      const prepared = prepareActorNavigation({ sdk, manager, targetId, options });
      if (!prepared) return { cancelled: false };
      if (options.summarize) check(session.model, "ERR_NAVIGATION_MODEL");
      const result = await runner.emit({ type: "session_before_tree", preparation: clone(prepared.preparation), signal });
      sameSnapshot();
      if (result?.cancel) return { cancelled: true };
      const effective = checkedOptions({ ...options,
        ...(result?.customInstructions !== undefined ? { customInstructions: result.customInstructions } : {}),
        ...(result?.replaceInstructions !== undefined ? { replaceInstructions: result.replaceInstructions } : {}),
        ...(result?.label !== undefined ? { label: result.label } : {}),
      });
      let summary, fromExtension = false;
      if (options.summarize && result?.summary) { summary = checkedResult(result.summary); fromExtension = true; }
      else if (options.summarize && prepared.preparation.entriesToSummarize.length) {
        const streamFn = (model, context, requestOptions) => {
          sameSnapshot();
          const stream = models.streamSimple(model, context, { ...requestOptions, signal,
            onPayload: payload => runner.emitBeforeProviderRequest(payload),
            transformHeaders: headers => runner.emitBeforeProviderHeaders(headers),
            onResponse: response => runner.emit({ type: "after_provider_response", ...response }),
          });
          streams.push(stream.result().then(message => ({ message }), error => ({ error })));
          return stream;
        };
        const generated = await sdk.generateBranchSummary(prepared.preparation.entriesToSummarize, {
          model: session.model, signal, customInstructions: effective.customInstructions,
          replaceInstructions: effective.replaceInstructions,
          reserveTokens: session.settingsManager.getBranchSummarySettings().reserveTokens,
          streamFn, retry: session.settingsManager.getRetrySettings(), callbacks: {
            onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => publish({ type: "summarization_retry_scheduled", attempt, maxAttempts, delayMs, errorMessage }),
            onRetryAttemptStart: () => publish({ type: "summarization_retry_attempt_start", source: "branchSummary" }),
            onRetryFinished: () => publish({ type: "summarization_retry_finished" }),
          },
        });
        if (generated.aborted) return { cancelled: true, aborted: true };
        if (generated.error) throw new ActorNavigationError("ERR_NAVIGATION_SUMMARY", generated.error);
        summary = checkedResult({ summary: generated.summary, usage: generated.usage,
          details: { readFiles: generated.readFiles ?? [], modifiedFiles: generated.modifiedFiles ?? [] } });
      }
      const completed = await Promise.all(streams);
      check(!completed.some(result => result.error), "ERR_NAVIGATION_STREAM_FAILED");
      sameSnapshot();
      const appended = [];
      let summaryEntry;
      // One synchronous canonical transition; no extension/provider await can interleave it.
      if (summary?.summary) {
        const id = manager.branchWithSummary(prepared.newLeafId, summary.summary, summary.details, fromExtension, summary.usage);
        committed = true; summaryEntry = manager.getEntry(id); appended.push(summaryEntry);
      } else {
        if (prepared.newLeafId === null) manager.resetLeaf(); else manager.branch(prepared.newLeafId);
        committed = true;
      }
      if (effective.label) {
        const id = manager.appendLabelChange(summaryEntry?.id ?? targetId, effective.label);
        appended.push(manager.getEntry(id));
      }
      session.agent.state.messages = projectCanonicalContext({ entries: manager.getEntries(), leafId: manager.getLeafId(),
        buildSessionContext: sdk.buildSessionContext, mode: "native" }).messages;
      outcome = { editorText: prepared.editorText, cancelled: false, summaryEntry };
      for (const entry of appended) await publish({ type: "entry_appended", entry });
      await runner.emit({ type: "session_tree", newLeafId: manager.getLeafId(), oldLeafId,
        summaryEntry, fromExtension: summaryEntry ? fromExtension : undefined });
      await lifecycle.afterCommit?.();
      return outcome;
    } catch (error) {
      if (committed) {
        const failure = new ActorNavigationError("ERR_NAVIGATION_COMMITTED", "Navigation committed; post-commit action failed", { cause: error });
        failure.committed = true; failure.result = outcome; throw failure;
      }
      if (signal.aborted || error.code === "ERR_NAVIGATION_ABORTED") return { cancelled: true, aborted: true };
      throw error;
    } finally {
      // Do not release the owner lease with a summary stream still in flight.
      await Promise.all(streams);
    }
  };
}
