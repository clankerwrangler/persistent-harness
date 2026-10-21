-------------------- MODULE InputDeliveryFailure --------------------
EXTENDS Naturals, TLC
CONSTANT Fault
VARIABLE s
vars == <<s>>
Current == s.record /\ s.generation=1 /\ s.stage="resident" /\ ~s.cancelled
Publish == Current \/ (Fault="stale" /\ s.generation#1) \/ (Fault="cancelled" /\ s.cancelled)
Init == s = [generation |-> 1, stage |-> "resident", record |-> TRUE, cancelled |-> FALSE,
  failed |-> FALSE, wake |-> "readiness", queued |-> FALSE, owner |-> TRUE,
  marker |-> 0, unsafe |-> FALSE, retry |-> FALSE]
\* Launch publishes resident before its first delivery finishes. The wake can
\* therefore queue a second operation behind a rejection-swallowing tail.
ObserveResident ==
  /\ s.wake="readiness" /\ s.stage="resident"
  /\ s'=[s EXCEPT !.wake="tail", !.queued=TRUE]
FailDelivery ==
  /\ ~s.failed
  /\ s'=[s EXCEPT !.failed=TRUE,
      !.marker=IF Fault#"missing" /\ Publish THEN 1 ELSE @,
      !.unsafe=@ \/ (Fault#"missing" /\ Publish /\ ~Current)]
CloseFailed ==
  /\ s.failed /\ s.generation=1 /\ ~s.cancelled /\ s.stage="resident"
  /\ s'=[s EXCEPT !.stage="error", !.record=FALSE]
UnexpectedExit ==
  /\ ~s.failed /\ Current
  /\ s'=[s EXCEPT !.stage="error", !.record=FALSE,
      !.marker=IF Fault="missing-exit" THEN @ ELSE 1]
TailReturn ==
  /\ s.failed /\ s.wake="tail" /\ (s.stage#"resident" \/ s.generation#1)
  /\ s'=[s EXCEPT !.wake="done", !.owner=FALSE]
ReadinessReject ==
  /\ s.failed /\ s.wake="readiness" /\ s.stage="error"
  /\ s'=[s EXCEPT !.wake="done", !.owner=FALSE, !.marker=1]
Stop ==
  /\ ~s.cancelled
  /\ s'=[s EXCEPT !.stage="stopped", !.record=FALSE, !.cancelled=TRUE, !.owner=FALSE]
Revive ==
  /\ s.cancelled /\ s.generation=1
  /\ s'=[s EXCEPT !.generation=2, !.stage="resident", !.record=TRUE, !.marker=0]
Retry ==
  /\ s.stage="error" /\ ~s.owner /\ ~s.retry
  /\ s'=[s EXCEPT !.retry=TRUE, !.marker=0, !.owner=TRUE]
Next == UnexpectedExit \/ ObserveResident \/ FailDelivery \/ CloseFailed \/ TailReturn \/ ReadinessReject \/ Stop \/ Revive \/ Retry
Spec == Init /\ [][Next]_vars
PendingFailureVisible == s.stage="error" /\ s.failed /\ ~s.owner => s.marker=1
PublicationOwned == ~s.unsafe
=============================================================================
