------------------------- MODULE VisibleTranscriptChunks -------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANT MaxChunk
\* Byte values are symbolic. Frame ends represent LF; the final frame starts
\* incomplete. Appends never change earlier bytes. JSON validation is abstracted
\* as a deterministic first invalid frame, independent of read partitioning.
VARIABLES size, target, offset, ends, accepted, pendingStart, badFrame, failed
vars == <<size, target, offset, ends, accepted, pendingStart, badFrame, failed>>
FrameEnds == <<2, 5, 8>>
Complete(n) == {i \in 1..3 : FrameEnds[i] <= n}
Init == /\ size = 6 /\ target = 6 /\ offset = 0 /\ ends = {}
        /\ accepted = {} /\ pendingStart = 0 /\ failed = FALSE
        /\ badFrame \in 0..3
AppendBytes == /\ size < 8 /\ size' = size + 1
          /\ UNCHANGED <<target, offset, ends, accepted, pendingStart, badFrame, failed>>
Refresh == /\ ~failed /\ offset = target /\ target < size /\ target' = size
           /\ UNCHANGED <<size, offset, ends, accepted, pendingStart, badFrame, failed>>
Read == /\ ~failed /\ offset < target
        /\ \E n \in 1..MaxChunk :
           /\ offset + n <= target
           /\ LET seen == Complete(offset + n)
                  invalid == badFrame # 0 /\ badFrame \in seen
                  good == IF invalid THEN {i \in seen : i < badFrame} ELSE seen
              IN /\ offset' = offset + n
                 /\ ends' = seen
                 /\ accepted' = good
                 /\ pendingStart' = IF seen = {} THEN 0 ELSE FrameEnds[Cardinality(seen)]
                 /\ failed' = invalid
        /\ UNCHANGED <<size, target, badFrame>>
Next == AppendBytes \/ Refresh \/ Read
Bounds == 0 <= offset /\ offset <= target /\ target <= size /\ size <= 8
ExactCompletedFrames == ends = Complete(offset)
NoIncompleteFrame == accepted \subseteq Complete(offset)
CanonicalPrefix == accepted = IF badFrame # 0 /\ badFrame \in Complete(offset)
                              THEN {i \in Complete(offset) : i < badFrame}
                              ELSE Complete(offset)
PendingOffset == pendingStart = IF ends = {} THEN 0 ELSE FrameEnds[Cardinality(ends)]
DeterministicFailure == failed = (badFrame # 0 /\ badFrame \in Complete(offset))
Spec == Init /\ [][Next]_vars
=================================================================================
