---------------------- MODULE BackgroundCompletions ----------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANT Capacity
Jobs == {"a1", "a2", "b1"}
Owners == {"a", "b"}
Owner(j) == IF j = "b1" THEN "b" ELSE "a"
Ids(s) == {s[i] : i \in 1..Len(s)}
VARIABLES flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, finished
vars == <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, finished>>
Init == /\ flight = {} /\ reserved = <<>> /\ published = {} /\ sent = {} /\ failed = {}
        /\ ready = {} /\ checkpoint = {} /\ admitted = <<>> /\ stopping = FALSE /\ closed = FALSE /\ finished = {}
\* Existing monitor owns each bounded dispatch; no startup wait owns discovery.
Launch(j) == /\ ~stopping /\ j \notin sent \cup flight /\ Cardinality(flight) < Capacity
             /\ flight' = flight \cup {j}
             /\ UNCHANGED <<reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed, finished>>
\* Session mutation covers durable reservation/publication, not actor readiness.
Persist(j) == /\ j \in flight /\ j \notin Ids(reserved)
              /\ reserved' = Append(reserved, j) /\ published' = published \cup {j}
              /\ UNCHANGED <<flight, sent, failed, ready, checkpoint, admitted, stopping, closed, finished>>
Ready(o) == /\ o \notin ready /\ ready' = ready \cup {o}
            /\ UNCHANGED <<flight, reserved, published, sent, failed, checkpoint, admitted, stopping, closed, finished>>
Success(j) == /\ j \in flight \cap Ids(reserved) /\ Owner(j) \in ready
              /\ flight' = flight \ {j} /\ sent' = sent \cup {j}
              /\ UNCHANGED <<reserved, published, failed, ready, checkpoint, admitted, stopping, closed, finished>>
Failure(j) == /\ j \in flight \cap Ids(reserved) /\ j \notin failed
              /\ flight' = flight \ {j} /\ failed' = failed \cup {j}
              /\ UNCHANGED <<reserved, published, sent, ready, checkpoint, admitted, stopping, closed, finished>>
Checkpoint(o) == /\ o \notin checkpoint /\ checkpoint' = checkpoint \cup {o}
              /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, admitted, stopping, closed, finished>>
EndRun(o) == /\ o \notin finished /\ finished' = finished \cup {o}
             /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, closed>>
Admit(j) == /\ j \in Ids(reserved) \ Ids(admitted) /\ Owner(j) \in ready \cap checkpoint
            /\ j = Head(SelectSeq(reserved, LAMBDA k: Owner(k) = Owner(j) /\ k \notin Ids(admitted)))
            /\ admitted' = Append(admitted, j)
            /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, stopping, closed, finished>>
Stop == /\ ~stopping /\ stopping' = TRUE
        /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, closed, finished>>
Close == /\ stopping /\ flight = {} /\ ~closed /\ closed' = TRUE
         /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, checkpoint, admitted, stopping, finished>>
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
=============================================================================
