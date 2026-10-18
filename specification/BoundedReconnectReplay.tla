------------------------- MODULE BoundedReconnectReplay -------------------------
EXTENDS Naturals, Sequences, TLC
CONSTANT Fault
VARIABLES stored, widths, budget, request, phase, initial, selected, bytes,
          fullCalls, wrapperCalls
vars == <<stored, widths, budget, request, phase, initial, selected, bytes,
          fullCalls, wrapperCalls>>

\* Widths are exact UTF-8 JSON lengths of {seq,event} wrappers, not event bytes.
\* JSON-plain data has no serialization callbacks. Requests can see new aliases.
Sum(s, w) == (IF Len(s) >= 1 THEN w[s[1]] ELSE 0)
           + (IF Len(s) >= 2 THEN w[s[2]] ELSE 0)
           + (IF Len(s) >= 3 THEN w[s[3]] ELSE 0)
ArrayBytes(s, w) == IF Len(s) = 0 THEN 2 ELSE 1 + Len(s) + Sum(s, w)
LastThree(w) == LET n == Len(w) IN SubSeq(<<1,2,3,4>>, IF n > 3 THEN n-2 ELSE 1, n)
Fits(s, w) == Len(s) <= 1 \/ ArrayBytes(s, w) <= budget
Reference(s, w) == IF Len(s) = 0 THEN <<>> ELSE
  LET first == CHOOSE k \in 1..Len(s) :
        /\ Fits(SubSeq(s, k, Len(s)), w)
        /\ \A j \in 1..(k-1) : ~Fits(SubSeq(s, j, Len(s)), w)
  IN SubSeq(s, first, Len(s))
InitialBytes(s, w) == IF Len(s) > 1 \/ Fault = "Eager" THEN ArrayBytes(s, w) ELSE 0
InitialCalls(s) == IF Len(s) > 1 \/ Fault = "Eager" THEN 1 ELSE 0

Init ==
  /\ stored \in UNION {[1..n -> {2,5,9}] : n \in 0..4}
  /\ widths = stored
  /\ budget \in {0,5,9,13,22,40}
  /\ request = 0 /\ phase = "run"
  /\ initial = LastThree(widths) /\ selected = initial
  /\ bytes = InitialBytes(initial, widths)
  /\ fullCalls = InitialCalls(initial) /\ wrapperCalls = 0
Trim ==
  /\ phase = "run" /\ Len(selected) > 1 /\ bytes > budget
  /\ bytes' = bytes - widths[Head(selected)] - (IF Fault = "Separator" THEN 0 ELSE 1)
  /\ selected' = IF Fault = "DropLast" THEN SubSeq(selected,1,Len(selected)-1) ELSE Tail(selected)
  /\ wrapperCalls' = wrapperCalls + 1
  /\ fullCalls' = fullCalls + (IF Fault = "Rescan" THEN 1 ELSE 0)
  /\ UNCHANGED <<stored, widths, budget, request, phase, initial>>
Finish ==
  /\ phase = "run" /\ (Len(selected) <= 1 \/ bytes <= budget)
  /\ phase' = "done"
  /\ UNCHANGED <<stored, widths, budget, request, initial, selected, bytes, fullCalls, wrapperCalls>>
NextRequest ==
  /\ phase = "done" /\ request = 0
  /\ widths' = [i \in 1..Len(widths) |-> IF widths[i] = 9 THEN 2 ELSE 9]
  /\ initial' = LastThree(widths') /\ selected' = initial'
  /\ bytes' = InitialBytes(initial', IF Fault = "Stale" THEN stored ELSE widths')
  /\ fullCalls' = InitialCalls(initial') /\ wrapperCalls' = 0
  /\ request' = 1 /\ phase' = "run"
  /\ UNCHANGED <<stored, budget>>
Next == Trim \/ Finish \/ NextRequest
Spec == Init /\ [][Next]_vars

Equivalent == phase = "done" => selected = Reference(initial, widths)
Accounting == Len(selected) > 1 => bytes = ArrayBytes(selected, widths)
OrderedSuffix == selected = SubSeq(initial, Len(initial)-Len(selected)+1, Len(initial))
AtLeastOne == Len(initial) > 0 => Len(selected) > 0
SingleFullScan == fullCalls <= 1
RemovedOnly == wrapperCalls = Len(initial)-Len(selected)
SmallInert == Len(initial) <= 1 => fullCalls = 0 /\ wrapperCalls = 0
FittingInert == Fits(initial, widths) => wrapperCalls = 0
=============================================================================
