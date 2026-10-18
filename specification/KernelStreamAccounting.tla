------------------------ MODULE KernelStreamAccounting ------------------------
EXTENDS Integers, Sequences, TLC
CONSTANT Fault
VARIABLES reference, candidate, limit, depth, work
vars == <<reference, candidate, limit, depth, work>>
Streams == {"stdout", "stderr"}
Other(k) == IF k = "stdout" THEN "stderr" ELSE "stdout"
Min(a,b) == IF a < b THEN a ELSE b
Max(a,b) == IF a > b THEN a ELSE b
Empty == [streams |-> [k \in Streams |-> <<>>], counts |-> [k \in Streams |-> 0],
          closed |-> [k \in Streams |-> FALSE], total |-> 0,
          outputs |-> <<>>, updates |-> <<>>, errors |-> <<>>]
\* Limits and maintained counts are doubled: odd limits retain fractional ends.
\* "nan" and "inf" preserve their existing arithmetic branches, not validation.
Limits == {[kind |-> "finite", value |-> n]: n \in {-3,-1,0,1,2,3,4,5,6,7,8,12}} \cup
          {[kind |-> "nan", value |-> 0], [kind |-> "inf", value |-> 0]}
Norms == {<<>>, <<65>>, <<194,162>>, <<229,173,151>>, <<240,159,152,128>>, <<65,229,173,151>>}
Chunks == {[bytes |-> b, raw |-> b]: b \in Norms} \cup
          {[bytes |-> <<239,191,189>>, raw |-> <<55296>>],
           [bytes |-> <<239,191,189>>, raw |-> <<56320>>]}
Count(s,k,isCandidate) ==
    IF ~isCandidate THEN 2*Len(s.streams[k])
    ELSE IF Fault = "shared" THEN s.counts[k] + s.counts[Other(k)] ELSE s.counts[k]
Remaining(s,k,isCandidate) == IF limit.kind \in {"nan","inf"} THEN 0 ELSE limit.value - Count(s,k,isCandidate)
Overflow(s,k,n,isCandidate) == IF limit.kind \in {"nan","inf"} THEN FALSE ELSE 2*n > Remaining(s,k,isCandidate)
\* Exact JS boundary loop: fractional array indices are absent; integer ones
\* retreat over continuation bytes. Negative ends retain subarray's semantics.
RECURSIVE Align(_,_)
Align(bytes,e) == IF e > 0 /\ e % 2 = 0 /\ e < 2*Len(bytes)
                    /\ bytes[e \div 2 + 1] \in 128..191
                 THEN Align(bytes,e-2) ELSE e
End(s,k,bytes,isCandidate) ==
    CASE limit.kind = "nan" -> 0 [] limit.kind = "inf" -> 2*Len(bytes)
      [] OTHER -> Align(bytes,Min(2*Len(bytes),Remaining(s,k,isCandidate)))
Trunc(e) == IF e >= 0 THEN e \div 2 ELSE -((-e) \div 2)
Slice(bytes,e) == LET n == Trunc(e)
                     stop == IF n < 0 THEN Max(0,Len(bytes)+n) ELSE Min(n,Len(bytes))
                 IN SubSeq(bytes,1,stop)
Width(b) == CASE b < 128 -> 1 [] b < 224 -> 2 [] b < 240 -> 3 [] OTHER -> 4
RECURSIVE Decode(_)
Decode(bytes) == IF Len(bytes) = 0 THEN <<>> ELSE
    LET n == Width(Head(bytes)) IN
    IF Len(bytes) < n THEN <<239,191,189>>
    ELSE SubSeq(bytes,1,n) \o Decode(SubSeq(bytes,n+1,Len(bytes)))
Text(outputs,text) == IF Len(text) = 0 THEN outputs ELSE
    IF Len(outputs) > 0 /\ outputs[Len(outputs)].kind = "text"
    THEN [outputs EXCEPT ![Len(outputs)].value = @ \o text]
    ELSE Append(outputs,[kind |-> "text",value |-> text])
Visible(s) == [streams |-> s.streams, closed |-> s.closed, total |-> s.total,
              outputs |-> s.outputs, updates |-> s.updates, errors |-> s.errors]
Add(s,k,chunk,throws,isCandidate) ==
    LET bytes == chunk.bytes
        e == End(s,k,bytes,isCandidate)
        retained == IF s.closed[k] THEN <<>> ELSE Slice(bytes,e)
        captured == IF isCandidate /\ Fault = "normalize" /\ retained = bytes /\ ~s.closed[k]
                    THEN chunk.raw ELSE Decode(retained)
        cut == ~s.closed[k] /\ Overflow(s,k,Len(bytes),isCandidate)
        delivery == captured \o (IF cut THEN <<-1>> ELSE <<>>)
        next == [s EXCEPT !.streams[k] = @ \o captured,
                 !.counts[k] = @ + (IF s.closed[k] THEN 0
                                   ELSE IF isCandidate /\ Fault = "assumedEnd" THEN e ELSE 2*Len(retained)),
                 !.closed[k] = @ \/ cut, !.total = @ + Len(bytes),
                 !.outputs = Text(Text(@,captured),IF cut THEN <<-1>> ELSE <<>>)]
        updated == IF Len(delivery) = 0 THEN next ELSE
                   [next EXCEPT !.updates = Append(@,[stream |-> k,text |-> delivery,
                                 streams |-> next.streams,closed |-> next.closed,total |-> next.total])]
    IN IF Len(delivery) > 0 /\ throws THEN [updated EXCEPT !.errors = Append(@,"callback")] ELSE updated
Init == /\ reference = Empty /\ candidate = Empty /\ limit \in Limits /\ depth = 0
        /\ work = [prefixScans |-> 0, buffers |-> 0, adds |-> 0]
AddStep(k,chunk,throws) ==
    /\ depth < 2 /\ reference' = Add(reference,k,chunk,throws,FALSE)
    /\ candidate' = Add(candidate,k,chunk,throws,TRUE)
    /\ work' = [prefixScans |-> work.prefixScans +
                    (IF Fault = "rescan" /\ ~candidate.closed[k] THEN 1 ELSE 0),
                buffers |-> work.buffers + (IF Fault = "normalize" THEN 0 ELSE 1),
                adds |-> work.adds + 1]
    /\ depth' = depth + 1 /\ UNCHANGED limit
Rich == /\ depth < 2
        /\ reference' = [reference EXCEPT !.outputs = Append(@,[kind |-> "mime",value |-> <<"image">>])]
        /\ candidate' = [candidate EXCEPT !.outputs = Append(@,[kind |-> "mime",value |-> <<"image">>])]
        /\ depth' = depth+1 /\ UNCHANGED <<limit,work>>
Fresh == /\ depth < 2 /\ reference' = Empty /\ candidate' = Empty
         /\ depth' = depth+1 /\ UNCHANGED <<limit,work>>
Next == (\E k \in Streams, chunk \in Chunks, throws \in BOOLEAN: AddStep(k,chunk,throws)) \/ Rich \/ Fresh
Equivalent == Visible(reference) = Visible(candidate)
ActiveAccounting == \A k \in Streams: ~candidate.closed[k] => candidate.counts[k] = 2*Len(candidate.streams[k])
ActualSliceCounts == \A k \in Streams: candidate.counts[k] >= 0 /\ candidate.counts[k] % 2 = 0
WorkPreserved == work.buffers = work.adds
NoPrefixScan == work.prefixScans = 0
Spec == Init /\ [][Next]_vars
=============================================================================
