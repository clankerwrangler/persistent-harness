----------------------------- MODULE EventLogTail -----------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Limit, MaxLines, Values, Blank, Malformed
VARIABLES lines, cursor, kept
vars == <<lines, cursor, kept>>
Nonempty(s) == SelectSeq(s, LAMBDA x: x # Blank)
Last(s, n) == IF Len(s) <= n THEN s ELSE SubSeq(s, Len(s) - n + 1, Len(s))
Parsed(s) == SelectSeq(s, LAMBDA x: x # Malformed)
Done == cursor = 0 \/ Len(kept) = Limit + 1
Init == /\ lines \in UNION {[1..n -> Values] : n \in 0..MaxLines}
        /\ cursor = Len(lines) /\ kept = <<>>
Read == /\ ~Done
        /\ cursor' = cursor - 1
        /\ kept' = IF lines[cursor] = Blank THEN kept ELSE <<lines[cursor]>> \o kept
        /\ UNCHANGED lines
Finish == /\ Done /\ UNCHANGED vars
Next == Read \/ Finish
TypeOK == /\ cursor \in 0..Len(lines) /\ kept \in Seq(Values \ {Blank})
BoundedRetention == Len(kept) <= Limit + 1
SuffixOwned == kept = Nonempty(SubSeq(lines, cursor + 1, Len(lines)))
CorrectLines == Done => Last(kept, Limit) = Last(Nonempty(lines), Limit)
CorrectEvents == Done => Parsed(Last(kept, Limit)) = Parsed(Last(Nonempty(lines), Limit))
CorrectTruncation == Done => (Len(kept) > Limit) = (Len(Nonempty(lines)) > Limit)
EventuallyDone == <>Done
\* Tokens represent complete lines in previous-then-current segment order.
\* Filesystem sampling, rotation, UTF-8 decoding, and chunk boundaries need tests.
Spec == Init /\ [][Next]_vars /\ WF_vars(Read)
=============================================================================
