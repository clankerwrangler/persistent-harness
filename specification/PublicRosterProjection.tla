---------------------- MODULE PublicRosterProjection ----------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS KeepPayload, DropParent, FilterFamily
VARIABLES fixture, caller, version, phase, sampled, actual, expected, payloadReads
vars == <<fixture, caller, version, phase, sampled, actual, expected, payloadReads>>
Ids == 1..4
Parent(i,v,f) == IF f = "cycle" /\ i \in {1,2} THEN 3-i
                ELSE IF f = "cross" /\ i = 1 THEN 3
                ELSE IF f = "missing" /\ i = 1 THEN 6
                ELSE IF i = 4 THEN IF v = 0 THEN 2 ELSE 1
                ELSE IF i = 2 THEN 1 ELSE 0
Rows(v,f) == [i \in Ids |-> [id |-> i, short |-> i, name |-> <<i,v>>,
  kind |-> IF i \in {1,3} /\ f # "cross" /\ f # "cycle" THEN "root" ELSE "child",
  depth |-> IF i \in {1,3} THEN 0 ELSE 1, parent |-> Parent(i,v,f),
  family |-> IF f = "cross" /\ i = 3 THEN 2 ELSE 1,
  activity |-> IF i = 4 \/ (i = 2 /\ v = 0) THEN "working" ELSE "idle",
  lifecycle |-> IF f = "deleted" /\ i = 2 THEN "deleted" ELSE "retained",
  cwd |-> i, repository |-> 0, unusedPayload |-> <<i,v,999>>]]
Live(v,f) == LET r == Rows(v,f) IN [i \in {j \in Ids : r[j].lifecycle # "deleted"} |-> r[i]]
Project(r) == [id |-> r.id, short |-> r.short, name |-> r.name, kind |-> r.kind,
  depth |-> r.depth, parent |-> IF DropParent THEN 0 ELSE r.parent, family |-> r.family,
  activity |-> r.activity, lifecycle |-> r.lifecycle, cwd |-> r.cwd, repository |-> r.repository]
Selected(rows,c) == [i \in {j \in DOMAIN rows : ~FilterFamily \/ c \notin DOMAIN rows \/ rows[j].family = rows[c].family} |-> Project(rows[i])]
Relation(a,b) == IF a.id = b.id THEN "self"
  ELSE IF a.parent = b.id THEN "parent" ELSE IF b.parent = a.id THEN "child"
  ELSE IF (a.kind = "root" /\ b.kind = "root" /\ a.family = b.family)
           \/ (a.parent # 0 /\ a.parent = b.parent) THEN "sibling" ELSE "none"
RECURSIVE Lineage(_,_,_)
Lineage(rows,i,seen) == IF i \notin DOMAIN rows \/ i \in seen THEN <<>>
  ELSE Lineage(rows,rows[i].parent,seen \cup {i}) \o <<rows[i].name>>
Desc(rows,i) == LET reach[n \in 0..4] == IF n = 0 THEN {i}
                 ELSE reach[n-1] \cup {j \in DOMAIN rows : rows[j].parent \in reach[n-1]}
               IN Cardinality({j \in reach[4] \cap DOMAIN rows : j # i /\ rows[j].activity = "working"})
Visible(rows,c) == {i \in DOMAIN rows : rows[i].family = rows[c].family /\ Relation(rows[c],rows[i]) # "none"}
Dto(rows,raw,c,i) == [sessionId |-> i, shortId |-> rows[i].short, name |-> rows[i].name,
 kind |-> rows[i].kind, depth |-> rows[i].depth, lineage |-> Lineage(rows,i,{}),
 relationship |-> Relation(rows[c],rows[i]), activity |-> rows[i].activity,
 lifecycle |-> rows[i].lifecycle, cwd |-> rows[i].cwd, repositoryRoot |-> rows[i].repository,
 workingDescendantCount |-> Desc(raw,i)]
\* Ordering is determined exclusively by retained relationship/activity/name/id.
\* Actual locale ordering and full wire/host parity are checked in the public probe.
Observe(rows,raw,c) == IF c \notin DOMAIN rows THEN "caller session does not exist"
 ELSE [roster |-> {Dto(rows,raw,c,i) : i \in Visible(rows,c)},
       countQueryIds |-> Visible(rows,c)]
Init == /\ fixture \in {"tree","cross","cycle","deleted","missing"}
        /\ caller \in 1..5 /\ version = 0 /\ phase = "before" /\ sampled = 0
        /\ actual = "unread" /\ expected = "unread" /\ payloadReads = 0
Change == /\ version = 0 /\ version' = 1
          /\ UNCHANGED <<fixture,caller,phase,sampled,actual,expected,payloadReads>>
Read == /\ phase = "before"
        /\ LET raw == Live(version,fixture) IN
           /\ expected' = Observe(raw,raw,caller)
           /\ actual' = Observe(Selected(raw,caller),raw,caller)
           /\ payloadReads' = IF KeepPayload THEN Cardinality(DOMAIN raw) ELSE 0
        /\ sampled' = version /\ phase' = "returned"
        /\ UNCHANGED <<fixture,caller,version>>
Next == Change \/ Read \/ /\ phase = "returned" /\ UNCHANGED vars
SamePublicFieldsRelationsLineageCountsErrors == phase = "returned" => actual = expected
NoUnusedPayloadMaterialization == phase = "returned" => payloadReads = 0
Spec == Init /\ [][Next]_vars
=============================================================================
