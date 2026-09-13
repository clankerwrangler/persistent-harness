-------------------------- MODULE InferenceRetry --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT MaxRetries
VARIABLES stage, kind, eligibleError, metadata, identityBound, enabled,
          attemptNumber, generation, revision, admitted, dispatched, providerTools,
          aborted, retired, fenced, snapshot, records, started, nextAttempt, errorType
vars == <<stage, kind, eligibleError, metadata, identityBound, enabled,
          attemptNumber, generation, revision, admitted, dispatched, providerTools,
          aborted, retired, fenced, snapshot, records, started, nextAttempt, errorType>>
Safe == /\ eligibleError /\ metadata /\ identityBound /\ enabled
        /\ attemptNumber <= MaxRetries /\ admitted = 0 /\ dispatched = 0
        /\ ~providerTools /\ ~aborted /\ retired /\ fenced
Decision == [retry |-> Safe, generation |-> generation, revision |-> revision,
             admitted |-> admitted, dispatched |-> dispatched, retired |-> retired,
             fenced |-> fenced, aborted |-> aborted, providerTools |-> providerTools,
             unknown |-> kind = "unknown", possibleProcessing |-> kind = "unknown",
             possibleUsage |-> kind = "unknown", attempt |-> attemptNumber]
Init == /\ stage = "ready" /\ kind \in {"unknown", "ordinary"}
        /\ errorType \in {"eof", "transport", "protocol"}
        /\ eligibleError \in BOOLEAN /\ (kind = "unknown" /\ eligibleError => errorType # "protocol") /\ metadata \in BOOLEAN /\ identityBound \in BOOLEAN
        /\ enabled \in BOOLEAN /\ attemptNumber \in 1..(MaxRetries + 1)
        /\ generation = 1 /\ revision = 0 /\ admitted \in 0..1 /\ dispatched \in 0..1
        /\ providerTools \in BOOLEAN /\ aborted \in BOOLEAN
        /\ retired \in BOOLEAN /\ fenced \in BOOLEAN
        /\ snapshot = [retry |-> FALSE, generation |-> 0, revision |-> 0,
             admitted |-> 0, dispatched |-> 0, retired |-> FALSE, fenced |-> FALSE,
             aborted |-> FALSE, providerTools |-> FALSE, unknown |-> FALSE,
             possibleProcessing |-> FALSE, possibleUsage |-> FALSE, attempt |-> 0]
        /\ records = {} /\ started = FALSE /\ nextAttempt = 0
Evaluate == /\ stage = "ready" /\ stage' = "planned" /\ snapshot' = Decision
            /\ records' = records \cup {Decision}
            /\ UNCHANGED <<kind, eligibleError, metadata, identityBound, enabled,
               attemptNumber, generation, revision, admitted, dispatched, providerTools,
               aborted, retired, fenced, started, nextAttempt, errorType>>
Delay == /\ stage = "planned" /\ stage' = "waiting"
         /\ UNCHANGED <<kind, eligibleError, metadata, identityBound, enabled,
            attemptNumber, generation, revision, admitted, dispatched, providerTools,
            aborted, retired, fenced, snapshot, records, started, nextAttempt, errorType>>
\* Owner re-observes after delay under the same attempt lease, rather than
\* treating the old pure-planner result as authority for another provider call.
Reevaluate == /\ stage \in {"waiting", "recorded"} /\ stage' = "recorded"
              /\ snapshot' = IF snapshot.generation = generation THEN Decision
                             ELSE [Decision EXCEPT !.retry = FALSE]
              /\ records' = records \cup {snapshot'}
              /\ UNCHANGED <<kind, eligibleError, metadata, identityBound, enabled,
                 attemptNumber, generation, revision, admitted, dispatched, providerTools,
                 aborted, retired, fenced, started, nextAttempt, errorType>>
StartNewInference ==
       /\ stage = "recorded" /\ snapshot.retry /\ Safe
       /\ snapshot.generation = generation /\ snapshot.revision = revision
       /\ stage' = "done" /\ started' = TRUE /\ nextAttempt' = attemptNumber + 1
       /\ UNCHANGED <<kind, eligibleError, metadata, identityBound, enabled,
          attemptNumber, generation, revision, admitted, dispatched, providerTools,
          aborted, retired, fenced, snapshot, records, errorType>>
Deny == /\ stage = "recorded" /\ ~snapshot.retry /\ stage' = "done"
        /\ UNCHANGED <<kind, eligibleError, metadata, identityBound, enabled,
           attemptNumber, generation, revision, admitted, dispatched, providerTools,
           aborted, retired, fenced, snapshot, records, started, nextAttempt, errorType>>
\* Canonical observations may resolve or cancellation can arrive during backoff.
\* These are historical counts, not outstanding-work counts: a real result never
\* decreases admission/dispatch history and does not enable tool replay.
RefreshFacts == /\ stage \in {"planned", "waiting", "recorded"} /\ revision < 2
                /\ revision' = revision + 1 /\ admitted' \in admitted..1
                /\ dispatched' \in dispatched..1 /\ aborted' \in {aborted, TRUE}
                /\ UNCHANGED <<stage, kind, eligibleError, metadata, identityBound, enabled,
                   attemptNumber, generation, providerTools, retired, fenced,
                   snapshot, records, started, nextAttempt, errorType>>
ReplaceGeneration == /\ stage \in {"planned", "waiting", "recorded"} /\ generation = 1
                     /\ generation' = 2 /\ revision' = revision + 1 /\ identityBound' = FALSE
                     /\ UNCHANGED <<stage, kind, eligibleError, metadata, enabled,
                        attemptNumber, admitted, dispatched, providerTools, aborted,
                        retired, fenced, snapshot, records, started, nextAttempt, errorType>>
\* Retired/fenced callbacks cannot admit a late old call even when a new request
\* is otherwise eligible. Real callback fencing remains the transport/owner duty.
LateOldFrame == /\ retired /\ fenced /\ UNCHANGED vars
Next == Evaluate \/ Delay \/ Reevaluate \/ StartNewInference \/ Deny
        \/ RefreshFacts \/ ReplaceGeneration \/ LateOldFrame
TypeOK == /\ stage \in {"ready", "planned", "waiting", "recorded", "done"}
          /\ admitted \in 0..1 /\ dispatched \in 0..1 /\ generation \in 1..2
          /\ revision \in 0..3 /\ attemptNumber \in 1..(MaxRetries + 1)
          /\ nextAttempt \in 0..(MaxRetries + 1)
EligibleOnly == started => Safe
FreshAtStart == started => snapshot.revision = revision /\ snapshot.generation = generation
NoToolReplay == started => admitted = 0 /\ dispatched = 0
BudgetBound == started => nextAttempt <= MaxRetries + 1
RetiredBeforeRetry == started => retired /\ fenced
UnknownPreserved == \A r \in records: r.unknown => r.possibleProcessing /\ r.possibleUsage
RecordBindsAttempt == \A r \in records: r.attempt = attemptNumber
OnlySafePlans == \A r \in records: r.retry => r.retired /\ r.fenced /\ ~r.aborted
                   /\ ~r.providerTools /\ r.admitted = 0 /\ r.dispatched = 0
UnknownTypedTransportOnly == started /\ kind = "unknown" => errorType \in {"eof", "transport"}
Spec == Init /\ [][Next]_vars
=============================================================================
