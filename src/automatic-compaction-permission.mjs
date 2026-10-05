export const AUTOMATIC_COMPACTION_CHECK = "persistent-harness:automatic-compaction-check";

/** Actor-local, synchronous permission only. Late vetoes cannot affect a later query. */
export function createAutomaticCompactionPermission(eventBus) {
  return (reason, contextWindow) => {
    let allowed = true, open = true;
    const request = Object.freeze({ version: 1, reason,
      contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
      veto: () => { if (open) allowed = false; },
    });
    try { eventBus?.emit(AUTOMATIC_COMPACTION_CHECK, request); }
    finally { open = false; }
    return allowed;
  };
}
