--------------------- MODULE HistoryMaintenance ---------------------
EXTENDS Naturals
CONSTANTS MaxVersion, DeferBusy, CancelOnResume
VARIABLES source, indexed, busy, pending, queued, writer, captured, cancelled,
          strictPending, snapshot, closed, busyStart, uncancelledBusy
vars == <<source, indexed, busy, pending, queued, writer, captured, cancelled,
          strictPending, snapshot, closed, busyStart, uncancelledBusy>>
Init == /\ source = 0 /\ indexed = 0 /\ busy = FALSE /\ pending = FALSE
        /\ queued = FALSE /\ writer = "none" /\ captured = 0 /\ cancelled = FALSE
        /\ strictPending = FALSE /\ snapshot = 0 /\ closed = FALSE
        /\ busyStart = FALSE /\ uncancelledBusy = FALSE
Append == /\ ~closed /\ source < MaxVersion /\ source' = source + 1 /\ pending' = TRUE
          /\ UNCHANGED <<indexed, busy, queued, writer, captured, cancelled,
                         strictPending, snapshot, closed, busyStart, uncancelledBusy>>
Resume == /\ ~closed /\ ~busy /\ busy' = TRUE
          /\ cancelled' = (cancelled \/ (writer = "auto" /\ CancelOnResume))
          /\ uncancelledBusy' = (uncancelledBusy \/ (writer = "auto" /\ ~CancelOnResume))
          /\ UNCHANGED <<source, indexed, pending, queued, writer, captured,
                         strictPending, snapshot, closed, busyStart>>
Settle == /\ ~closed /\ busy /\ busy' = FALSE
          /\ UNCHANGED <<source, indexed, pending, queued, writer, captured, cancelled,
                         strictPending, snapshot, closed, busyStart, uncancelledBusy>>
AutoQueue == /\ ~closed /\ pending /\ ~queued /\ writer # "auto" /\ (~DeferBusy \/ ~busy)
             /\ queued' = TRUE
             /\ UNCHANGED <<source, indexed, busy, pending, writer, captured, cancelled,
                            strictPending, snapshot, closed, busyStart, uncancelledBusy>>
AutoStart == /\ ~closed /\ queued /\ writer = "none" /\ (~DeferBusy \/ ~busy)
             /\ queued' = FALSE /\ writer' = "auto" /\ captured' = source /\ cancelled' = FALSE
             /\ busyStart' = (busyStart \/ busy)
             /\ UNCHANGED <<source, indexed, busy, pending, strictPending, snapshot,
                            closed, uncancelledBusy>>
DeferQueued == /\ ~closed /\ queued /\ busy /\ queued' = FALSE
               /\ UNCHANGED <<source, indexed, busy, pending, writer, captured, cancelled,
                              strictPending, snapshot, closed, busyStart, uncancelledBusy>>
StrictRequest == /\ ~closed /\ ~strictPending /\ strictPending' = TRUE
                 /\ UNCHANGED <<source, indexed, busy, pending, queued, writer, captured,
                                cancelled, snapshot, closed, busyStart, uncancelledBusy>>
StrictStart == /\ ~closed /\ strictPending /\ writer = "none"
               /\ writer' = "strict" /\ captured' = source /\ cancelled' = FALSE
               /\ strictPending' = FALSE
               /\ UNCHANGED <<source, indexed, busy, pending, queued, snapshot,
                              closed, busyStart, uncancelledBusy>>
Finish == /\ writer # "none"
          /\ indexed' = IF ~closed /\ ~cancelled /\ captured = source THEN captured ELSE indexed
          /\ pending' = (~closed /\ source # indexed')
          /\ writer' = "none" /\ cancelled' = FALSE
          /\ UNCHANGED <<source, busy, queued, captured, strictPending, snapshot,
                         closed, busyStart, uncancelledBusy>>
Snapshot == /\ ~closed /\ snapshot' = indexed
            /\ UNCHANGED <<source, indexed, busy, pending, queued, writer, captured,
                           cancelled, strictPending, closed, busyStart, uncancelledBusy>>
Close == /\ ~closed /\ closed' = TRUE /\ pending' = FALSE /\ queued' = FALSE
         /\ cancelled' = (writer # "none") /\ strictPending' = FALSE
         /\ UNCHANGED <<source, indexed, busy, writer, captured, snapshot, busyStart, uncancelledBusy>>
Next == Append \/ Resume \/ Settle \/ AutoQueue \/ AutoStart \/ DeferQueued
        \/ StrictRequest \/ StrictStart \/ Finish \/ Snapshot \/ Close
NoBusyAutoStart == ~busyStart
ResumeCancelsOnlyAutomatic == ~uncancelledBusy
DirtyCoverageRetained == ~closed /\ source # indexed => pending
VerifiedPublication == indexed <= source /\ snapshot <= indexed
SnapshotIndependent == ~closed => ENABLED Snapshot
StrictNotGatedByBusy == ~closed /\ strictPending /\ writer = "none" => ENABLED StrictStart
QuietPendingCanQueue == ~closed /\ pending /\ ~busy /\ ~queued /\ writer # "auto" => ENABLED AutoQueue
Spec == Init /\ [][Next]_vars
=============================================================================
