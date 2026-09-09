import { ACTOR_INPUT_MESSAGE_TYPE } from "./protocol.mjs";
import { canonicalInputContent, canonicalActorInputContent, resolveActorInputAssociation } from "./conversation-projection.mjs";

export const SESSION_ACTION_TIMEOUT_MS = 330_000;
export const KERNEL_RELOAD_COMMAND = "/persistent-harness-reload-kernel";
export const BRANCH_COMMAND = "/persistent-harness-branch";
const BRANCH_ENTRY_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function retryBranchMessage(inputEntryId) {
  return `${BRANCH_COMMAND} ${parseRetryBranchTarget(inputEntryId).entryId}`;
}

export function parseRetryBranchTarget(args) {
  const target = typeof args === "string" ? args.trim() : "";
  if (!BRANCH_ENTRY_ID.test(target)) throw new Error("invalid retry input entry target");
  return { entryId: target };
}

export async function applyRetryBranch(ctx, args) {
  const plan = parseRetryBranchTarget(args);
  const branch = ctx.sessionManager.getBranch();
  const index = branch.findIndex((entry) => entry.id === plan.entryId);
  const input = branch[index];
  if (!input || !(input.type === "custom_message" || (input.type === "message" && input.message?.role === "user"))) {
    throw new Error("retry target must be an active canonical input entry");
  }
  if (!branch.slice(index + 1).some((entry) => entry.type === "message" && entry.message?.role === "assistant")) {
    throw new Error("retry input has no assistant response to replace");
  }
  // Pi excludes the selected user/custom input and rebuilds its model context.
  const result = await ctx.navigateTree(plan.entryId, { summarize: false });
  if (result?.cancelled) throw new Error("retry navigation was cancelled");
  if (ctx.sessionManager.getLeafId() !== input.parentId) {
    throw new Error("retry navigation did not reach the input parent");
  }
  return { ...plan, branchFromId: input.parentId };
}

export function retryIntentForRequest(params) {
  if (!params.retryOf) return null;
  return { targetId: params.retryOf,
    mode: params.retryOriginal === true ? "original" : "explicit" };
}

export function canonicalRetryInput(entry, { sessionId, inputReceipt, inputAssociation, canonicalEntries } = {}) {
  const association = inputAssociation ?? resolveActorInputAssociation(canonicalEntries ?? [entry],
    { sessionId, inputReceipt, complete: canonicalEntries !== undefined });
  if (association.state === "unresolved") throw new Error("canonical retry input association is unresolved");
  if (association.state === "proven" && association.entryId === entry.id) {
    const proof = association.proof;
    return { entryId: entry.id, originalInputId: proof.inputId, ...canonicalActorInputContent(entry, inputReceipt),
      source: proof.source ?? "user", origin: proof.source === "cron" || proof.source === "background" ? proof.origin : null };
  }
  if (entry?.type === "message" && entry.message?.role === "user") {
    return { entryId: entry.id, originalInputId: null, ...canonicalInputContent(entry.message.content ?? entry.message.text),
      source: "user", origin: null };
  }
  if (entry?.type !== "custom_message" || entry.customType !== ACTOR_INPUT_MESSAGE_TYPE) {
    throw new Error("canonical retry input is not a supported user or harness input");
  }
  throw new Error("canonical retry input has no verified internal provenance");
}
