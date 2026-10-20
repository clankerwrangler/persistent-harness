---------------------- MODULE BackgroundCompletions ----------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANT Capacity, IgnoreScanOwners
Jobs == {"a1", "a2", "b1"}
Owners == {"a", "b"}
Owner(j) == IF j = "b1" THEN "b" ELSE "a"
Ids(s) == {s[i] : i \in 1..Len(s)}
VARIABLES flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, finished
baseVars == <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, finished>>
VARIABLE scanState
vars == <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, finished, scanState>>
ScanInitial == [phase |-> "idle", owned |-> {}, snapshot |-> {}, visited |-> {},
  flight |-> {}, sent |-> {}, failed |-> {}, retried |-> {}, replayed |-> {},
  counts |-> [j \in Jobs |-> 0]]
Init == /\ flight = {} /\ reserved = <<>> /\ published = {} /\ sent = {} /\ failed = {}
        /\ ready = {} /\ checkpoint = {} /\ admitted = <<>> /\ stopping = FALSE /\ closed = FALSE /\ finished = {} /\ scanState = ScanInitial
\* Existing monitor owns each bounded dispatch; no startup wait owns discovery.
Launch(j) == /\ ~stopping /\ j \notin sent \cup flight /\ Cardinality(flight) < Capacity
             /\ flight' = flight \cup {j}
             /\ UNCHANGED <<reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, finished, scanState>>
\* Session mutation covers durable reservation/publication, not actor readiness.
Persist(j) == /\ j \in flight /\ j \notin Ids(reserved)
              /\ reserved' = Append(reserved, j) /\ published' = published \cup {j}
              /\ UNCHANGED <<flight, sent, failed, ready, checkpoint, admitted, stopping, closed, finished, scanState>>
Ready(o) == /\ o \notin ready /\ ready' = ready \cup {o}
            /\ UNCHANGED <<flight, reserved, published, sent, failed, checkpoint, admitted, stopping, closed, finished, scanState>>
Success(j) == /\ j \in flight \cap Ids(reserved) /\ Owner(j) \in ready
              /\ flight' = flight \ {j} /\ sent' = sent \cup {j}
              /\ UNCHANGED <<reserved, published, failed, ready, checkpoint, admitted, stopping, closed, finished, scanState>>
Failure(j) == /\ j \in flight \cap Ids(reserved) /\ j \notin failed
              /\ flight' = flight \ {j} /\ failed' = failed \cup {j}
              /\ UNCHANGED <<reserved, published, sent, ready, checkpoint, admitted, stopping, closed, finished, scanState>>
Checkpoint(o) == /\ o \notin checkpoint /\ checkpoint' = checkpoint \cup {o}
              /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, admitted, stopping, closed, finished, scanState>>
EndRun(o) == /\ o \notin finished /\ finished' = finished \cup {o}
             /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, scanState>>
Admit(j) == /\ j \in Ids(reserved) \ Ids(admitted) /\ Owner(j) \in ready \cap checkpoint
            /\ j = Head(SelectSeq(reserved, LAMBDA k: Owner(k) = Owner(j) /\ k \notin Ids(admitted)))
            /\ admitted' = Append(admitted, j)
            /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, stopping, closed, finished, scanState>>
Stop == /\ ~stopping /\ stopping' = TRUE
        /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, closed, finished, scanState>>
Close == /\ stopping /\ flight = {} /\ ~closed /\ closed' = TRUE
         /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, finished, scanState>>
Next == (\E j \in Jobs: Launch(j) \/ Persist(j) \/ Success(j) \/ Failure(j) \/ Admit(j))
        \/ (\E o \in Owners: Ready(o) \/ Checkpoint(o) \/ EndRun(o)) \/ Stop \/ Close
BoundedOwnership == Cardinality(flight) <= Capacity /\ (closed => flight = {})
TruthfulHandoff == sent \subseteq Ids(reserved) /\ \A j \in sent: Owner(j) \in ready
VisibleAtAcceptance == Ids(reserved) = published
ExactlyOnce == Len(reserved) = Cardinality(Ids(reserved)) /\ Len(admitted) = Cardinality(Ids(admitted))
SafeCheckpointBoundary == \A j \in Ids(admitted): Owner(j) \in checkpoint
ColdOwnerDoesNotLockAcceptance == \A j \in flight \ Ids(reserved): ENABLED Persist(j)
DiscoveryNotReadinessGated == ~stopping /\ Cardinality(flight) < Capacity =>
    \A j \in Jobs \ (sent \cup flight): ENABLED Launch(j)
CheckpointNotTurnEndGated == \A o \in (ready \cap checkpoint) \ finished:
    LET waiting == SelectSeq(reserved, LAMBDA j: Owner(j) = o /\ j \notin Ids(admitted))
    IN Len(waiting) > 0 => ENABLED Admit(Head(waiting))
OwnerOrder == \A o \in Owners:
    LET a == SelectSeq(admitted, LAMBDA j: Owner(j) = o)
        r == SelectSeq(reserved, LAMBDA j: Owner(j) = o)
    IN a = SubSeq(r, 1, Len(a))
Spec == Init /\ [][Next]_vars

\* Independent finite scan/dispatch projection. A completed notification read
\* can be older than a dispatch which publishes while the scan awaits other I/O.
ScanBegin == /\ scanState.phase = "idle"
 /\ scanState' = [scanState EXCEPT !.phase = "reading", !.owned = scanState.flight]
ScanRead == /\ scanState.phase = "reading"
 /\ scanState' = [scanState EXCEPT !.phase = "admitting",
      !.snapshot = Jobs \ scanState.sent, !.visited = {}]
ScanVisit(j) == /\ scanState.phase = "admitting" /\ j \in scanState.snapshot \ scanState.visited
 /\ LET admit == j \notin scanState.flight /\ Cardinality(scanState.flight) < Capacity
                 /\ (IgnoreScanOwners \/ j \notin scanState.owned) /\ scanState.counts[j] < 2
    IN scanState' = [scanState EXCEPT !.visited = @ \cup {j},
       !.flight = IF admit THEN @ \cup {j} ELSE @,
       !.counts[j] = IF admit THEN @ + 1 ELSE @,
       !.retried = IF admit /\ j \in scanState.failed THEN @ \cup {j} ELSE @,
       !.replayed = IF admit /\ j \in scanState.sent THEN @ \cup {j} ELSE @]
ScanFinish == /\ scanState.phase = "admitting" /\ scanState.visited = scanState.snapshot
 /\ scanState' = [scanState EXCEPT !.phase = "idle"]
ScanSucceed(j) == /\ j \in scanState.flight
 /\ scanState' = [scanState EXCEPT !.flight = @ \ {j}, !.sent = @ \cup {j}]
ScanFail(j) == /\ j \in scanState.flight /\ j \notin scanState.failed
 /\ scanState' = [scanState EXCEPT !.flight = @ \ {j}, !.failed = @ \cup {j}]
ScanNext == /\ (ScanBegin \/ ScanRead \/ ScanFinish
               \/ (\E j \in Jobs: ScanVisit(j) \/ ScanSucceed(j) \/ ScanFail(j)))
            /\ UNCHANGED baseVars
ScanSpec == Init /\ [][ScanNext]_vars
 /\ WF_vars(ScanBegin /\ UNCHANGED baseVars) /\ WF_vars(ScanRead /\ UNCHANGED baseVars) /\ WF_vars(ScanFinish /\ UNCHANGED baseVars)
 /\ (\A j \in Jobs: WF_vars(ScanVisit(j) /\ UNCHANGED baseVars)
                  /\ WF_vars(ScanSucceed(j) /\ UNCHANGED baseVars))
ScanSafety == /\ Cardinality(scanState.flight) <= Capacity
 /\ Cardinality(scanState.owned) <= Capacity /\ scanState.replayed = {}
 /\ (scanState.sent \cap scanState.failed) \subseteq scanState.retried
ScanEventuallyCompletes == <> (scanState.sent = Jobs)
=============================================================================
