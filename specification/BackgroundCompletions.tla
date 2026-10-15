---------------------- MODULE BackgroundCompletions ----------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANT Capacity
Jobs == {"a1", "a2", "b1"}
Owners == {"a", "b"}
Owner(j) == IF j = "b1" THEN "b" ELSE "a"
Ids(s) == {s[i] : i \in 1..Len(s)}
VARIABLES flight, reserved, published, sent, failed, ready, safe, admitted, stopping, closed
vars == <<flight, reserved, published, sent, failed, ready, safe, admitted, stopping, closed>>
Init == /\ flight = {} /\ reserved = <<>> /\ published = {} /\ sent = {} /\ failed = {}
        /\ ready = {} /\ safe = {} /\ admitted = <<>> /\ stopping = FALSE /\ closed = FALSE
\* Existing monitor owns each bounded dispatch; no startup wait owns discovery.
Launch(j) == /\ ~stopping /\ j \notin sent \cup flight /\ Cardinality(flight) < Capacity
             /\ flight' = flight \cup {j}
             /\ UNCHANGED <<reserved, published, sent, failed, ready, safe, admitted, stopping, closed>>
\* Session mutation covers durable reservation/publication, not actor readiness.
Persist(j) == /\ j \in flight /\ j \notin Ids(reserved)
              /\ reserved' = Append(reserved, j) /\ published' = published \cup {j}
              /\ UNCHANGED <<flight, sent, failed, ready, safe, admitted, stopping, closed>>
Ready(o) == /\ o \notin ready /\ ready' = ready \cup {o}
            /\ UNCHANGED <<flight, reserved, published, sent, failed, safe, admitted, stopping, closed>>
Success(j) == /\ j \in flight \cap Ids(reserved) /\ Owner(j) \in ready
              /\ flight' = flight \ {j} /\ sent' = sent \cup {j}
              /\ UNCHANGED <<reserved, published, failed, ready, safe, admitted, stopping, closed>>
Failure(j) == /\ j \in flight \cap Ids(reserved) /\ j \notin failed
              /\ flight' = flight \ {j} /\ failed' = failed \cup {j}
              /\ UNCHANGED <<reserved, published, sent, ready, safe, admitted, stopping, closed>>
EndTurn(o) == /\ o \notin safe /\ safe' = safe \cup {o}
              /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, admitted, stopping, closed>>
Admit(j) == /\ j \in Ids(reserved) \ Ids(admitted) /\ Owner(j) \in ready \cap safe
            /\ j = Head(SelectSeq(reserved, LAMBDA k: Owner(k) = Owner(j) /\ k \notin Ids(admitted)))
            /\ admitted' = Append(admitted, j)
            /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, safe, stopping, closed>>
Stop == /\ ~stopping /\ stopping' = TRUE
        /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, safe, admitted, closed>>
Close == /\ stopping /\ flight = {} /\ ~closed /\ closed' = TRUE
         /\ UNCHANGED <<flight, reserved, published, sent, failed, ready, safe, admitted, stopping>>
Next == (\E j \in Jobs: Launch(j) \/ Persist(j) \/ Success(j) \/ Failure(j) \/ Admit(j))
        \/ (\E o \in Owners: Ready(o) \/ EndTurn(o)) \/ Stop \/ Close
BoundedOwnership == Cardinality(flight) <= Capacity /\ (closed => flight = {})
TruthfulHandoff == sent \subseteq Ids(reserved) /\ \A j \in sent: Owner(j) \in ready
VisibleAtAcceptance == Ids(reserved) = published
ExactlyOnce == Len(reserved) = Cardinality(Ids(reserved)) /\ Len(admitted) = Cardinality(Ids(admitted))
FollowUpBoundary == \A j \in Ids(admitted): Owner(j) \in safe
ColdOwnerDoesNotLockAcceptance == \A j \in flight \ Ids(reserved): ENABLED Persist(j)
DiscoveryNotReadinessGated == ~stopping /\ Cardinality(flight) < Capacity =>
    \A j \in Jobs \ (sent \cup flight): ENABLED Launch(j)
OwnerOrder == \A o \in Owners:
    LET a == SelectSeq(admitted, LAMBDA j: Owner(j) = o)
        r == SelectSeq(reserved, LAMBDA j: Owner(j) = o)
    IN a = SubSeq(r, 1, Len(a))
Spec == Init /\ [][Next]_vars
=============================================================================
