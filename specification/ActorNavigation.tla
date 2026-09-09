------------------------- MODULE ActorNavigation -------------------------
EXTENDS Naturals
VARIABLES phase, lease, summaryFlight, cancelled, stale, writes, before, after,
          targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError
vars == <<phase, lease, summaryFlight, cancelled, stale, writes, before, after,
          targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
Init == /\ phase = "idle" /\ lease = FALSE /\ summaryFlight = FALSE
        /\ cancelled = FALSE /\ stale = FALSE /\ writes = 0 /\ before = 0 /\ after = 0
        /\ targetKind \in {"user", "custom", "other"} /\ summarize \in BOOLEAN /\ custom \in BOOLEAN
        /\ leaf = "old" /\ contextLeaf = "old" /\ queued = FALSE /\ providerCalls = 0 /\ toolEffects = 0 /\ signature = "old" /\ inferenceCalls = 0
        /\ recoveryDone = TRUE /\ recoveryLeaf = "old" /\ seenLeaf = "old" /\ usageLeaf = "old" /\ committedError = FALSE
Reserve == /\ phase = "idle" /\ phase' = "prepared" /\ lease' = TRUE
           /\ UNCHANGED <<summaryFlight, cancelled, stale, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
Before == /\ phase = "prepared" /\ phase' = "hooked" /\ before' = 1
          /\ UNCHANGED <<lease, summaryFlight, cancelled, stale, writes, after, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
StartSummary == /\ phase = "hooked" /\ summarize /\ ~custom /\ ~cancelled /\ ~stale
                /\ phase' = "streaming" /\ summaryFlight' = TRUE /\ providerCalls' = providerCalls + 1
                /\ UNCHANGED <<lease, cancelled, stale, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, queued, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
FinishSummary == /\ phase = "streaming" /\ phase' = "ready" /\ summaryFlight' = FALSE
                 /\ UNCHANGED <<lease, cancelled, stale, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
NoSummary == /\ phase = "hooked" /\ (~summarize \/ custom) /\ phase' = "ready"
             /\ UNCHANGED <<lease, summaryFlight, cancelled, stale, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
Cancel == /\ phase \in {"prepared", "hooked", "streaming", "ready"} /\ cancelled' = TRUE
          /\ UNCHANGED <<phase, lease, summaryFlight, stale, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
Invalidate == /\ phase \in {"prepared", "hooked", "streaming", "ready"} /\ stale' = TRUE
              /\ UNCHANGED <<phase, lease, summaryFlight, cancelled, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
Commit == /\ phase = "ready" /\ lease /\ ~cancelled /\ ~stale /\ ~summaryFlight
          /\ phase' = "committed" /\ writes' = 1
          /\ leaf' = IF summarize THEN "summary" ELSE IF targetKind = "other" THEN "target" ELSE "parent"
          /\ contextLeaf' = leaf' /\ signature' = "selected"
          /\ UNCHANGED <<lease, summaryFlight, cancelled, stale, before, after, targetKind, summarize, custom, queued, providerCalls, toolEffects, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
\* Successful return and committed-error propagation both invalidate cached owner state.
After == /\ phase = "committed" /\ after' = 1 /\ phase' = "done" /\ lease' = FALSE
         /\ recoveryDone' = FALSE /\ seenLeaf' = "empty" /\ usageLeaf' = "none"
         /\ UNCHANGED <<summaryFlight, cancelled, stale, writes, before, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryLeaf, committedError>>
Fail == /\ phase \in {"prepared", "hooked", "ready", "committed"} /\ ~summaryFlight
        /\ phase' = "failed" /\ lease' = FALSE
        /\ committedError' = (phase = "committed")
        /\ recoveryDone' = IF committedError' THEN FALSE ELSE recoveryDone
        /\ seenLeaf' = IF committedError' THEN "empty" ELSE seenLeaf
        /\ usageLeaf' = IF committedError' THEN "none" ELSE usageLeaf
        /\ UNCHANGED <<summaryFlight, cancelled, stale, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, recoveryLeaf>>
Queue == /\ lease /\ queued' = TRUE
         /\ UNCHANGED <<phase, lease, summaryFlight, cancelled, stale, writes, before, after, targetKind, summarize, custom, leaf, contextLeaf, providerCalls, toolEffects, signature, inferenceCalls, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
DispatchQueued == /\ phase \in {"done", "failed"} /\ ~lease /\ queued /\ inferenceCalls = 0
                  /\ recoveryDone /\ inferenceCalls' = 1
                  /\ UNCHANGED <<phase, lease, summaryFlight, cancelled, stale, writes, before, after,
                       targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, recoveryDone, recoveryLeaf, seenLeaf, usageLeaf, committedError>>
RecoverQueued == /\ phase \in {"done", "failed"} /\ ~lease /\ queued /\ ~recoveryDone
                 /\ recoveryDone' = TRUE /\ recoveryLeaf' = leaf /\ seenLeaf' = leaf
                 /\ UNCHANGED <<phase, lease, summaryFlight, cancelled, stale, writes, before, after,
                      targetKind, summarize, custom, leaf, contextLeaf, queued, providerCalls, toolEffects, signature, inferenceCalls, usageLeaf, committedError>>
Next == RecoverQueued \/ DispatchQueued \/ Reserve \/ Before \/ StartSummary \/ FinishSummary \/ NoSummary \/ Cancel \/ Invalidate \/ Commit \/ After \/ Fail \/ Queue
SingleCommit == writes <= 1 /\ before <= 1 /\ after <= writes
CancellationBeforeMutation == cancelled \/ stale => writes = 0 /\ leaf = "old"
QuiescentOwnership == summaryFlight => lease
NoServiceFlightAfterRelease == ~lease => ~summaryFlight
RebuiltCanonicalContext == contextLeaf = leaf
NoEffectReplay == toolEffects = 0
HookBeforeMutation == writes = 1 => before = 1
SummaryIntent == providerCalls > 0 => summarize /\ ~custom
QueuedInferenceExclusion == lease => inferenceCalls = 0
SelectedSignatureProjection == writes = 1 => signature = "selected"
CommittedErrorIsExplicit == committedError <=> phase = "failed" /\ writes = 1
BookkeepingAfterCommit == ~lease /\ writes = 1 =>
    /\ (recoveryDone => recoveryLeaf = leaf /\ seenLeaf = leaf)
    /\ (~recoveryDone => seenLeaf = "empty")
    /\ usageLeaf = "none"
RecoveryBeforeInference == inferenceCalls = 1 => recoveryDone /\ recoveryLeaf = leaf /\ seenLeaf = leaf
Spec == Init /\ [][Next]_vars
=============================================================================
