---------------------- MODULE TranscriptCacheResidency ----------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Files, Readers, Budget, MaxSessions, Fault
VARIABLES order, weights, charged, phase, selected, localWeight, valid, blocked,
          lost, stale
vars == <<order, weights, charged, phase, selected, localWeight, valid, blocked, lost, stale>>
RECURSIVE Total(_, _), Remove(_, _), Trim(_, _)
Total(s,w) == IF Len(s)=0 THEN 0 ELSE w[Head(s)]+Total(Tail(s),w)
Remove(s,f) == IF Len(s)=0 THEN << >> ELSE IF Head(s)=f THEN Remove(Tail(s),f)
              ELSE <<Head(s)>> \o Remove(Tail(s),f)
Trim(s,w) == IF Len(s)=0 \/ (Total(s,w)<=Budget /\ Len(s)<=MaxSessions)
             THEN s ELSE Trim(Tail(s),w)
Cached == {order[i] : i \in 1..Len(order)}
Busy(f) == \E r \in Readers: phase[r]="working" /\ selected[r]=f
Init == /\ order= << >> /\ weights=[f \in Files |-> 0] /\ charged=0
        /\ phase=[r \in Readers |-> "idle"] /\ selected=[r \in Readers |-> CHOOSE f \in Files: TRUE]
        /\ localWeight=[r \in Readers |-> 0] /\ valid=[r \in Readers |-> TRUE]
        /\ blocked=[r \in Readers |-> FALSE] /\ lost=FALSE /\ stale=FALSE
Begin(r,f) == /\ phase[r]="idle" /\ ~Busy(f)
              /\ phase'=[phase EXCEPT ![r]="working"] /\ selected'=[selected EXCEPT ![r]=f]
              /\ localWeight'=[localWeight EXCEPT ![r]=IF f \in Cached THEN weights[f] ELSE 1]
              /\ order'=IF Fault="keep-active" THEN order ELSE Remove(order,f)
              /\ charged'=Total(order',weights)
              /\ UNCHANGED <<weights, valid, blocked, lost, stale>>
Grow(r) == /\ phase[r]="working" /\ localWeight[r]<Budget+1
           /\ localWeight'=[localWeight EXCEPT ![r]=@+1]
           /\ UNCHANGED <<order, weights, charged, phase, selected, valid, blocked, lost, stale>>
Publish(r) == /\ phase[r]="working"
              /\ LET f==selected[r]
                      admissible==localWeight[r]<=Budget /\ (~blocked[r] \/ Fault="clear")
                      w==[weights EXCEPT ![f]=localWeight[r]]
                      q==IF admissible THEN Append(Remove(order,f),f) ELSE Remove(order,f)
                      kept==IF Fault="bytes" THEN q ELSE Trim(q,w)
                  IN /\ order'=kept /\ weights'=w /\ charged'=Total(kept,w)
                     /\ stale'=(stale \/ (admissible /\ blocked[r]))
              /\ phase'=[phase EXCEPT ![r]="snapshot"]
              /\ UNCHANGED <<selected, localWeight, valid, blocked, lost>>
Evict(f) == /\ f \in Cached /\ order'=Remove(order,f) /\ charged'=Total(order',weights)
            /\ valid'=IF Fault="destroy" THEN
                  [r \in Readers |-> valid[r] /\ ~(selected[r]=f /\ phase[r]="snapshot")] ELSE valid
            /\ UNCHANGED <<weights, phase, selected, localWeight, blocked, lost, stale>>
Clear(f) == /\ order'=Remove(order,f) /\ charged'=Total(order',weights)
            /\ blocked'=[r \in Readers |-> blocked[r] \/ (selected[r]=f /\ phase[r]="working")]
            /\ UNCHANGED <<weights, phase, selected, localWeight, valid, lost, stale>>
Return(r) == /\ phase[r]="snapshot" /\ phase'=[phase EXCEPT ![r]="done"]
             /\ lost'=(lost \/ ~valid[r] \/ (Fault="lookup" /\ selected[r] \notin Cached))
             /\ UNCHANGED <<order, weights, charged, selected, localWeight, valid, blocked, stale>>
Next == (\E r \in Readers, f \in Files: Begin(r,f))
        \/ (\E r \in Readers: Grow(r) \/ Publish(r) \/ Return(r))
        \/ (\E f \in Files: Evict(f) \/ Clear(f))
Spec == Init /\ [][Next]_vars
CacheBudget == charged<=Budget /\ Len(order)<=MaxSessions
AccountingExact == charged=Total(order,weights)
WorkingOwnerDetached == \A r \in Readers: phase[r]="working" => selected[r] \notin Cached
LocalGraphIntact == \A r \in Readers: valid[r]
OperationResultSurvivesEviction == ~lost
ClearFencesAdmission == ~stale
NoDuplicateOwners == Cardinality(Cached)=Len(order)
TypeOK == /\ order \in Seq(Files) /\ weights \in [Files -> 0..(Budget+1)]
          /\ phase \in [Readers -> {"idle","working","snapshot","done"}]
          /\ localWeight \in [Readers -> 0..(Budget+1)]
=============================================================================
