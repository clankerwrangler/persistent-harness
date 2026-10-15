------------------------- MODULE ConcurrencyFixtures -------------------------
EXTENDS Naturals
CONSTANTS Rendezvous, NoFollow, CallbackIndependent, Backlog
VARIABLES filePhase, detached, fileError, grepPhase, swapped, leaked,
          waiting, callback, queued, completed
vars == <<filePhase, detached, fileError, grepPhase, swapped, leaked,
          waiting, callback, queued, completed>>
Init == /\ filePhase = "prepare" /\ detached = FALSE /\ fileError = FALSE
        /\ grepPhase = "enumerate" /\ swapped = FALSE /\ leaked = FALSE
        /\ waiting = TRUE /\ callback = FALSE /\ queued = Backlog /\ completed = 0
Publish == /\ filePhase = "prepare" /\ filePhase' = "published"
           /\ UNCHANGED <<detached, fileError, grepPhase, swapped, leaked, waiting, callback, queued, completed>>
Detach == /\ filePhase = "published" /\ ~detached /\ detached' = TRUE
          /\ UNCHANGED <<filePhase, fileError, grepPhase, swapped, leaked, waiting, callback, queued, completed>>
Verify == /\ filePhase = "published" /\ (~Rendezvous \/ detached)
          /\ filePhase' = "verified" /\ fileError' = detached
          /\ UNCHANGED <<detached, grepPhase, swapped, leaked, waiting, callback, queued, completed>>
Enumerate == /\ grepPhase = "enumerate" /\ grepPhase' = "named"
             /\ UNCHANGED <<filePhase, detached, fileError, swapped, leaked, waiting, callback, queued, completed>>
Swap == /\ grepPhase = "named" /\ ~swapped /\ swapped' = TRUE
        /\ UNCHANGED <<filePhase, detached, fileError, grepPhase, leaked, waiting, callback, queued, completed>>
Open == /\ grepPhase = "named" /\ (~Rendezvous \/ swapped)
        /\ grepPhase' = "done" /\ leaked' = (swapped /\ ~NoFollow)
        /\ UNCHANGED <<filePhase, detached, fileError, swapped, waiting, callback, queued, completed>>
Confirm == /\ waiting /\ ~callback /\ (CallbackIndependent \/ queued = 0)
           /\ callback' = TRUE
           /\ UNCHANGED <<filePhase, detached, fileError, grepPhase, swapped, leaked, waiting, queued, completed>>
Resume == /\ waiting /\ callback /\ waiting' = FALSE
          /\ UNCHANGED <<filePhase, detached, fileError, grepPhase, swapped, leaked, callback, queued, completed>>
Drain == /\ ~waiting /\ queued > 0 /\ queued' = queued - 1 /\ completed' = completed + 1
         /\ UNCHANGED <<filePhase, detached, fileError, grepPhase, swapped, leaked, waiting, callback>>
Next == Publish \/ Detach \/ Verify \/ Enumerate \/ Swap \/ Open \/ Confirm \/ Resume \/ Drain
Spec == Init /\ [][Next]_vars /\ WF_vars(Publish) /\ WF_vars(Detach) /\ WF_vars(Verify)
        /\ WF_vars(Enumerate) /\ WF_vars(Swap) /\ WF_vars(Open)
        /\ WF_vars(Confirm) /\ WF_vars(Resume) /\ WF_vars(Drain)
ObservedCommitFailure == filePhase = "verified" => detached /\ fileError
ObservedDirectorySwap == grepPhase = "done" => swapped
NoPrivateRead == ~leaked
ExactlyOnceDrain == queued + completed = Backlog
Completion == <> (filePhase = "verified" /\ grepPhase = "done" /\ completed = Backlog)
=============================================================================
