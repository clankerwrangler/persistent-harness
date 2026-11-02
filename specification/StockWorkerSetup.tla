------------------------- MODULE StockWorkerSetup -------------------------
\* Sources:
\*   test/e2e-stock-worker.test.mjs sha256:a2fdc742831a12e514fec75bf7bf688407c87c1319623d65be82ca96117ca0c2
EXTENDS Naturals
VARIABLES phase, owned, aborted, active, lateStart
vars == <<phase, owned, aborted, active, lateStart>>
Init == /\ phase = "new" /\ owned = FALSE /\ aborted = FALSE /\ active = FALSE /\ lateStart = FALSE
Own == /\ phase = "new" /\ owned' = TRUE /\ phase' = "copying"
       /\ UNCHANGED <<aborted, active, lateStart>>
CopySettles == /\ phase = "copying" /\ phase' = "ready"
               /\ UNCHANGED <<owned, aborted, active, lateStart>>
Abort == /\ ~aborted /\ aborted' = TRUE /\ UNCHANGED <<phase, owned, active, lateStart>>
Start == /\ phase = "ready" /\ ~aborted /\ phase' = "running"
         /\ active' = TRUE /\ lateStart' = aborted /\ UNCHANGED owned
         /\ UNCHANGED aborted
Cleanup == /\ owned /\ phase \in {"ready", "running"} /\ phase' = "closed" /\ active' = FALSE
           /\ UNCHANGED <<owned, aborted, lateStart>>
Next == Own \/ CopySettles \/ Abort \/ Start \/ Cleanup
OwnedSetup == phase # "new" => owned
NoLateStart == ~lateStart
DrainedCleanup == phase = "closed" => ~active
CancellationFence == phase = "ready" /\ aborted => ~ENABLED Start
Spec == Init /\ [][Next]_vars /\ WF_vars(Own) /\ WF_vars(CopySettles) /\ WF_vars(Cleanup)
CancelledCleanup == aborted => <> (phase = "closed")
=============================================================================
