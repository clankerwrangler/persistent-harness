---------------------- MODULE LiveConversationAccounting ----------------------
EXTENDS Integers, Sequences, FiniteSets, TLC
CONSTANTS IDs, ByteLimit, RowLimit, Fault
ASSUME RowLimit = 2 /\ ByteLimit > 0
VARIABLES reference, candidate, checked, work
vars == <<reference, candidate, checked, work>>

\* One-step induction over every bounded, ordered initial row state. Byte counts
\* represent stored chunks, not re-encoding joined text. Prefix is an abstract
\* valid UTF-8 prefix length; concrete Unicode is checked by the public witness.
RECURSIVE Sum(_)
Sum(rows) == IF Len(rows) = 0 THEN 0 ELSE Head(rows).bytes + Sum(Tail(rows))
Min(a,b) == IF a < b THEN a ELSE b
Max(a,b) == IF a > b THEN a ELSE b
Index(rows,id) == CHOOSE i \in 1..Len(rows): rows[i].id = id
Present(rows,id) == \E i \in 1..Len(rows): rows[i].id = id
Empty(id) == [id |-> id, bytes |-> 0, complete |-> FALSE, truncated |-> FALSE]
Ensure(s,id) == IF Present(s.rows,id) THEN s ELSE [s EXCEPT !.rows = Append(@,Empty(id))]
Without(rows,id) == SelectSeq(rows,LAMBDA r: r.id # id)
Drop(s,id,kind,isCandidate) ==
    LET n == s.rows[Index(s.rows,id)].bytes IN
    [s EXCEPT !.rows = Without(@,id),
              !.total = IF isCandidate /\ Fault = kind THEN @ ELSE @ - n]
Reset(s,id,isCandidate) ==
    LET i == Index(s.rows,id) IN
    [s EXCEPT !.total = IF isCandidate /\ Fault = "replace" THEN @ ELSE @ - s.rows[i].bytes,
              !.rows[i].bytes = 0, !.rows[i].truncated = FALSE]
Eligible(s,id,n) == n > 0 /\ ~s.rows[Index(s.rows,id)].truncated
Fits(s,id,n) == Eligible(s,id,n) /\ n <= ByteLimit - s.total
AppendBytes(s,id,n,prefix) ==
    IF ~Eligible(s,id,n) THEN s ELSE
    LET i == Index(s.rows,id)
        fits == Fits(s,id,n)
        nbytes == IF fits THEN n ELSE Min(prefix,Max(0,ByteLimit - s.total)) IN
    [s EXCEPT !.rows[i].bytes = @ + nbytes, !.total = @ + nbytes,
              !.rows[i].truncated = ~fits]

\* Same ordered trim loop; only its byte-budget source differs. Reference Sum
\* represents the old once-per-trim materialization/reduction, not a new owner.
Budget(s,isCandidate) == IF isCandidate /\ Fault # "resum" THEN s.total ELSE Sum(s.rows)
RECURSIVE TrimScan(_,_,_)
TrimScan(s,pending,isCandidate) ==
    IF Len(pending) = 0 \/ (Budget(s,isCandidate) <= ByteLimit /\ Len(s.rows) <= RowLimit) THEN s ELSE
    LET row == Head(pending)
        skip == ~row.complete /\ Len(s.rows) <= RowLimit
        dropped == IF skip THEN s ELSE Drop(s,row.id,"evict",isCandidate)
        marked == IF ~skip /\ ~row.complete THEN [dropped EXCEPT !.cut = TRUE] ELSE dropped IN
    TrimScan(marked,Tail(pending),isCandidate)
Trim(s,isCandidate) ==
    LET pending == IF isCandidate /\ Fault = "order"
                   THEN [i \in 1..Len(s.rows) |-> s.rows[Len(s.rows)+1-i]] ELSE s.rows IN
    TrimScan(s,pending,isCandidate)
Prepare(s,op,id,isCandidate) ==
    IF op = "replace" THEN Reset(Ensure(s,id),id,isCandidate) ELSE Ensure(s,id)
HasTrim(op) == op \in {"append","replace","complete"}
BeforeTrim(s,op,id,n,prefix,complete,isCandidate) ==
    LET prepared == Prepare(s,op,id,isCandidate)
        appended == IF op \in {"append","replace"} THEN AppendBytes(prepared,id,n,prefix) ELSE prepared IN
    IF op = "complete" \/ op = "replace"
    THEN [appended EXCEPT !.rows[Index(appended.rows,id)].complete = complete] ELSE appended
Apply(s,op,id,n,prefix,complete,isCandidate) ==
    CASE HasTrim(op) -> Trim(BeforeTrim(s,op,id,n,prefix,complete,isCandidate),isCandidate)
      [] op = "remove" -> IF Present(s.rows,id) THEN Drop(s,id,"remove",isCandidate) ELSE s
      [] op = "reconcile" -> IF Present(s.rows,id) /\ s.rows[Index(s.rows,id)].complete
                            THEN Drop(s,id,"reconcile",isCandidate) ELSE s
      [] op = "settle" -> [s EXCEPT !.rows = [i \in 1..Len(@) |-> [@ [i] EXCEPT !.complete = TRUE]]]
      [] op = "start" -> [s EXCEPT !.cut = FALSE]
Work(s,op,id,n,isCandidate) ==
    LET prepared == Prepare(s,op,id,isCandidate)
        appendOp == op \in {"append","replace"}
        fits == appendOp /\ Fits(prepared,id,n)
        overflow == appendOp /\ Eligible(prepared,id,n) /\ ~fits IN
    [fitBuffers |-> IF fits /\ (~isCandidate \/ Fault = "eager") THEN 1 ELSE 0,
     overflowBuffers |-> IF overflow THEN 1 ELSE 0,
     trimRows |-> IF HasTrim(op) /\ (~isCandidate \/ Fault = "resum") THEN Len(prepared.rows) ELSE 0]

Row == [id: IDs, bytes: 0..ByteLimit, complete: BOOLEAN, truncated: BOOLEAN]
\* This qualification fixes RowLimit=2, permitting all pre-states with 0..2 rows.
InitialRows == {<<>>} \cup {<<a>>: a \in Row} \cup
               {rows \in {<<a,b>>: a,b \in Row}: rows[1].id # rows[2].id /\ Sum(rows) <= ByteLimit}
Init == /\ \E rows \in InitialRows, cut \in BOOLEAN:
              reference = [rows |-> rows,total |-> Sum(rows),cut |-> cut]
        /\ candidate = reference /\ checked = FALSE
        /\ work = [fitBuffers |-> 0,overflowBuffers |-> 0,trimRows |-> 0]
Step(op,id,n,prefix,complete) ==
    /\ ~checked /\ prefix <= ByteLimit /\ (op = "complete" => complete)
    /\ reference' = Apply(reference,op,id,n,prefix,complete,FALSE)
    /\ candidate' = Apply(candidate,op,id,n,prefix,complete,TRUE)
    /\ work' = Work(candidate,op,id,n,TRUE) /\ checked' = TRUE
Next == \E op \in {"append","replace","complete","remove","reconcile","settle","start"},
           id \in IDs, n \in 0..(ByteLimit+1), prefix \in 0..ByteLimit, complete \in BOOLEAN:
           Step(op,id,n,prefix,complete)
Accounting == candidate.total = Sum(candidate.rows) /\ reference.total = Sum(reference.rows)
Equivalent == candidate = reference
Bounds == candidate.total >= 0 /\ candidate.total <= ByteLimit /\ Len(candidate.rows) <= RowLimit
WorkEliminated == work.fitBuffers = 0 /\ work.trimRows = 0
Spec == Init /\ [][Next]_vars
=============================================================================
