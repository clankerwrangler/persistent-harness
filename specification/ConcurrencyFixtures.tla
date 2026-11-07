------------------------- MODULE ConcurrencyFixtures -------------------------
\* Sources:
\*   test/files-atomic-cas.test.mjs sha256:14cd107f9dad82a42cb7b655d74843a57dae98624a15074b82bbd36048b32f0e
\*   test/host-handlers-hardening.test.mjs sha256:813374dcd42b8252b4f6da7dbe36091c4cc58aca5ef36a1b7f527f95a41b11f2
\*   test/supervisor-transport.test.mjs sha256:8514910b8e3b371a8badd8bf69ffda8aebb0ed39271786808e1c0d253e8ca8cb
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
