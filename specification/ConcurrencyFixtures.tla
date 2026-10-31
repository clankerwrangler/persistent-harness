------------------------- MODULE ConcurrencyFixtures -------------------------
\* Sources:
\*   test/files-atomic-cas.test.mjs sha256:96b68038ae61e3bc50d516c3256be78218d0882291647d747a89142be46be9ee
\*   test/host-handlers-hardening.test.mjs sha256:d26c4939b328e41327288f714c5a3e29f07c3d83a107f49a56c693fa171f8b65
\*   test/supervisor-transport.test.mjs sha256:c108ab1d35dddae098fd4b935a827e8b5d9a5eccb6a1802fcdb10d21e343ddd8
\*   src/grep-worker.mjs sha256:1057c5db98f556974370579578d05ffff649b02d5ed6e7a826ca4283ec89d525

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
