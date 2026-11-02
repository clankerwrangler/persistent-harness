------------------- MODULE AutomaticCompactionPermission -------------------
\* Sources:
\*   src/automatic-compaction-permission.mjs sha256:295549ffaaf636b722b3061bb2ad8d5be8de73f28606807ffb7f36657f3385af
\*   src/actor-coordinator.mjs sha256:d33d75f88913edccec70c1cc2df0391a3e909d958f96acfd890c3b774935ae62
\*   src/actor-compaction.mjs sha256:043eb1861c7490795a5b2fd582848d14bb8e157d4361844d1e23c851f0a6e12e
\*   src/sdk-worker.mjs sha256:ad3637bdce0be9028c01b99eb3b0c619d76473b0def01bae88de50127622ea0a

EXTENDS Naturals
VARIABLES phase, reason, listener, policyDenies, vetoed, sealedVeto,
          archiveReads, starts, writes, retries, inputDelivered, originalError
vars == <<phase, reason, listener, policyDenies, vetoed, sealedVeto,
          archiveReads, starts, writes, retries, inputDelivered, originalError>>
Init == /\ phase = "ready" /\ reason \in {"threshold", "overflow"}
        /\ listener \in BOOLEAN /\ policyDenies \in BOOLEAN
        /\ vetoed = FALSE /\ sealedVeto = FALSE
        /\ archiveReads = 0 /\ starts = 0 /\ writes = 0 /\ retries = 0
        /\ inputDelivered = FALSE /\ originalError = (reason = "overflow")
\* Reload invalidates old subscriptions. Only the current closure participates.
Reload == /\ phase = "ready" /\ listener' \in BOOLEAN /\ policyDenies' \in BOOLEAN
          /\ UNCHANGED <<phase, reason, vetoed, sealedVeto, archiveReads, starts,
                         writes, retries, inputDelivered, originalError>>
Dispatch == /\ phase = "ready" /\ phase' = "open"
            /\ vetoed' = listener /\ policyDenies
            /\ UNCHANGED <<reason, listener, policyDenies, sealedVeto, archiveReads,
                           starts, writes, retries, inputDelivered, originalError>>
OtherVeto == /\ phase = "open" /\ vetoed' = TRUE
             /\ UNCHANGED <<phase, reason, listener, policyDenies, sealedVeto,
                            archiveReads, starts, writes, retries, inputDelivered, originalError>>
Seal == /\ phase = "open" /\ phase' = "sealed" /\ sealedVeto' = vetoed
        /\ UNCHANGED <<reason, listener, policyDenies, vetoed, archiveReads,
                       starts, writes, retries, inputDelivered, originalError>>
\* Out-of-window callbacks and attempted unveto cannot change the sealed decision.
LateReply == /\ phase \in {"sealed", "done"} /\ UNCHANGED vars
Skip == /\ phase = "sealed" /\ sealedVeto /\ phase' = "done"
        /\ inputDelivered' = (reason = "threshold")
        /\ UNCHANGED <<reason, listener, policyDenies, vetoed, sealedVeto,
                       archiveReads, starts, writes, retries, originalError>>
Stock == /\ phase = "sealed" /\ ~sealedVeto /\ phase' = "done"
         /\ archiveReads' = 1 /\ starts' = 1
         /\ writes' = IF policyDenies THEN 0 ELSE 1
         /\ retries' = IF ~policyDenies /\ reason = "overflow" THEN 1 ELSE 0
         /\ inputDelivered' = (reason = "threshold")
         /\ UNCHANGED <<reason, listener, policyDenies, vetoed, sealedVeto, originalError>>
Next == Reload \/ Dispatch \/ OtherVeto \/ Seal \/ LateReply \/ Skip \/ Stock
Spec == Init /\ [][Next]_vars
NoWorkOnVeto == sealedVeto => archiveReads = 0 /\ starts = 0 /\ writes = 0 /\ retries = 0
StickyDecision == phase \in {"sealed", "done"} => sealedVeto = vetoed
CurrentListenerHonored == phase \in {"sealed", "done"} /\ listener /\ policyDenies => sealedVeto
OverflowFailurePreserved == reason = "overflow" /\ sealedVeto => originalError /\ retries = 0
InputProgressOnSkip == phase = "done" /\ sealedVeto /\ reason = "threshold" => inputDelivered
LegacyVetoPreserved == policyDenies => writes = 0 /\ retries = 0
=============================================================================
