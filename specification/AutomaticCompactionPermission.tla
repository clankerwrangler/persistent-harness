------------------- MODULE AutomaticCompactionPermission -------------------
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
