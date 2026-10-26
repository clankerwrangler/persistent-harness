-------------------- MODULE SessionOpenProjection --------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES phase, source, branch, boundSource, boundBranch, cursor, mode,
          selected, dependencies, hydrated, digest, verified, result, payload,
          cacheCharge, accepted
vars == <<phase,source,branch,boundSource,boundBranch,cursor,mode,selected,
          dependencies,hydrated,digest,verified,result,payload,cacheCharge,accepted>>
Rows == {"page", "older", "receipt", "abandoned"}
Family == {"page", "older"}
Active(b) == IF b=0 THEN {"page", "older", "receipt"} ELSE {"abandoned"}
Visible(b) == Active(b) \ {"receipt"}
Full(r) == [id |-> r, entryId |-> r, time |-> 1, body |-> "long payload",
            delivery |-> [state |-> "delivered", deliveredAt |-> 1]]
Compact(r) == [id |-> r, time |-> 1, delivery |-> [state |-> "delivered"]]
Expand(c) == [id |-> c.id, entryId |-> IF Fault="compact" THEN "wrong" ELSE c.id, time |-> c.time, body |-> "long payload",
              delivery |-> [state |-> c.delivery.state, deliveredAt |-> c.time]]
Requested(b,m) == Family \cap Visible(b) \cap (IF m="target" THEN {"older"} ELSE Rows)
Expected(b,m) == [r \in Requested(b,m) |->
                   IF m="delivery" THEN [delivery |-> Full(r).delivery] ELSE Full(r)]
Init == /\ phase="idle" /\ source=0 /\ branch=0 /\ boundSource=0 /\ boundBranch=0
        /\ cursor=0 /\ mode="delivery" /\ selected={} /\ dependencies={}
        /\ hydrated={} /\ digest=FALSE /\ verified=FALSE /\ result = << >>
        /\ payload=FALSE /\ cacheCharge=2 /\ accepted=FALSE
Begin(m,b) == /\ phase="idle" /\ phase'="working" /\ mode'=m /\ cursor'=b
              /\ boundSource'=source /\ boundBranch'=branch
              /\ UNCHANGED <<source,branch,selected,dependencies,hydrated,digest,verified,
                   result,payload,cacheCharge,accepted>>
Select == /\ phase="working"
          /\ phase'=(IF cursor=boundBranch \/ Fault="cursor" THEN "hydrate" ELSE "failed")
          /\ selected'=IF Visible(boundBranch)={} THEN {} ELSE {CHOOSE r \in Visible(boundBranch): TRUE}
          /\ dependencies'=IF Fault="eager" \/ mode \in {"full", "target"}
                            THEN Requested(boundBranch,mode) ELSE {}
          /\ UNCHANGED <<source,branch,boundSource,boundBranch,cursor,mode,hydrated,digest,
               verified,result,payload,cacheCharge,accepted>>
Hydrate == /\ phase="hydrate" /\ hydrated'=selected \cup dependencies
           /\ digest'=(source=boundSource) /\ verified'=(branch=boundBranch)
           /\ phase'=(IF (source=boundSource \/ Fault="digest")
                         /\ (branch=boundBranch \/ Fault="source") THEN "return" ELSE "failed")
           /\ UNCHANGED <<source,branch,boundSource,boundBranch,cursor,mode,selected,
                dependencies,result,payload,cacheCharge,accepted>>
Return == /\ phase="return" /\ phase'="done" /\ accepted'=TRUE
          /\ result'=(IF Fault="missing" THEN << >> ELSE Expected(boundBranch,mode))
          /\ payload'=(Fault="payload") /\ cacheCharge'=(IF Fault="budget" THEN 4 ELSE 2)
          /\ UNCHANGED <<source,branch,boundSource,boundBranch,cursor,mode,selected,
               dependencies,hydrated,digest,verified>>
ChangeSource == /\ source=0 /\ source'=1
                /\ UNCHANGED <<phase,branch,boundSource,boundBranch,cursor,mode,selected,
                     dependencies,hydrated,digest,verified,result,payload,cacheCharge,accepted>>
ChangeBranch == /\ branch=0 /\ branch'=1
                /\ UNCHANGED <<phase,source,boundSource,boundBranch,cursor,mode,selected,
                     dependencies,hydrated,digest,verified,result,payload,cacheCharge,accepted>>
Next == (\E m \in {"delivery","full","target"}, b \in 0..1: Begin(m,b))
        \/ Select \/ Hydrate \/ Return \/ ChangeSource \/ ChangeBranch
Spec == Init /\ [][Next]_vars
CompactRoundTrip == phase="done" => \A r \in Rows: Expand(Compact(r))=Full(r)
BoundedPageWork == mode="delivery" /\ phase \in {"return","done"} => hydrated=selected
SourceGuards == accepted => digest /\ verified
CursorGuard == accepted => cursor=boundBranch
CompleteOutput == accepted => result = Expected(boundBranch,mode)
BoundedCache == ~payload /\ cacheCharge<=3
=============================================================================
