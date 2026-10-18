------------------------- MODULE PendingInputReads -------------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS JoinedReads, SkipNoopClear, FreshAfterAwait
VARIABLES pending, accepted, wake, phase, kind, beforeAwait, returned, expected,
          queries, payloadReads, mutated, expectedMutated, generation
vars == <<pending, accepted, wake, phase, kind, beforeAwait, returned, expected,
          queries, payloadReads, mutated, expectedMutated, generation>>
Inputs == {1, 2}
Ordered(ids) == SelectSeq(<<1, 2>>, LAMBDA i: i \in ids)
\* Immutable tokens stand for complete receipt and payload values. Receipt order
\* and acceptance time are not the payload's transport-acceptance generation.
Row(i, errors) == [id |-> i, receipt |-> <<i, "owner", i * 10, i>>,
                  payload |-> <<i, i, i>>, acceptedGeneration |-> accepted[i],
                  wakeError |-> errors[i]]
Rows(ids, errors) == [n \in 1..Len(Ordered(ids)) |-> Row(Ordered(ids)[n], errors)]
ReadCost(ids) == IF JoinedReads THEN 1 ELSE 1 + 2 * Cardinality(ids)
Init == /\ pending \in SUBSET Inputs /\ accepted \in [Inputs -> 0..2]
        /\ wake \in [Inputs -> 0..2] /\ phase = "start" /\ kind = "none"
        /\ beforeAwait = {} /\ returned = <<>> /\ expected = <<>>
        /\ queries = 0 /\ payloadReads = 0 /\ mutated = {} /\ expectedMutated = {}
        /\ generation = 0
Exists == /\ phase = "start" /\ phase' = "done" /\ kind' = "exists"
          /\ returned' = <<pending # {}>> /\ expected' = <<pending # {}>>
          /\ queries' = 1 /\ payloadReads' = 0
          /\ UNCHANGED <<pending, accepted, wake, beforeAwait, mutated, expectedMutated, generation>>
List == /\ phase = "start" /\ phase' = "done" /\ kind' = "list"
        /\ returned' = Rows(pending, wake) /\ expected' = Rows(pending, wake)
        /\ queries' = ReadCost(pending) /\ payloadReads' = Cardinality(pending)
        /\ UNCHANGED <<pending, accepted, wake, beforeAwait, mutated, expectedMutated, generation>>
SetWake(g) == LET changed == {i \in pending: wake[i] # g}
                 selected == IF g = 0 THEN changed ELSE pending
                 nextWake == [i \in Inputs |-> IF i \in pending THEN g ELSE wake[i]]
             IN /\ phase = "start" /\ phase' = "done" /\ kind' = "wake"
                /\ generation' = g /\ wake' = nextWake
                /\ mutated' = changed /\ expectedMutated' = changed
                /\ returned' = Rows(selected, nextWake) /\ expected' = Rows(selected, nextWake)
                /\ queries' = IF selected = {} THEN 1 ELSE 1 + ReadCost(selected)
                /\ payloadReads' = IF g = 0 /\ changed = {} /\ ~SkipNoopClear
                                   THEN Cardinality(pending) ELSE Cardinality(selected)
                /\ UNCHANGED <<pending, accepted, beforeAwait>>
BeginAwait == /\ phase = "start" /\ phase' = "awaiting" /\ kind' = "delivery"
              /\ beforeAwait' = pending
              /\ UNCHANGED <<pending, accepted, wake, returned, expected, queries,
                             payloadReads, mutated, expectedMutated, generation>>
\* Canonical completion or new admission can change the queue while transcript
\* reconciliation awaits. The later selection must not reuse the earlier list.
ChangeDuringAwait(ids) == /\ phase = "awaiting" /\ phase' = "resumed"
                          /\ pending' = ids
                          /\ UNCHANGED <<accepted, wake, kind, beforeAwait, returned, expected,
                                         queries, payloadReads, mutated, expectedMutated, generation>>
Resume == LET selected == IF FreshAfterAwait THEN pending ELSE beforeAwait
          IN /\ phase = "resumed" /\ phase' = "done"
             /\ returned' = Rows(selected, wake) /\ expected' = Rows(pending, wake)
             /\ queries' = ReadCost(selected) /\ payloadReads' = Cardinality(selected)
             /\ UNCHANGED <<pending, accepted, wake, kind, beforeAwait, mutated, expectedMutated, generation>>
Next == Exists \/ List \/ BeginAwait \/ Resume \/ (\E g \in 0..2: SetWake(g))
        \/ (\E ids \in SUBSET Inputs: ChangeDuringAwait(ids))
Spec == Init /\ [][Next]_vars
ReceiptPayloadParity == phase = "done" => returned = expected
ExactMutationScope == mutated = expectedMutated
JoinedQueryBound == phase = "done" => queries <= (IF kind = "wake" THEN 2 ELSE 1)
ExistenceStaysCold == kind = "exists" => payloadReads = 0
NoopClearStaysCold == phase = "done" /\ kind = "wake" /\ generation = 0 /\ mutated = {}
                     => payloadReads = 0 /\ queries = 1
=============================================================================
