-------------------- MODULE CronActiveRunProbe --------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Fault
VARIABLES rows, target, phase, result, firstResult, oracle, cells, payloads
vars == <<rows, target, phase, result, firstResult, oracle, cells, payloads>>
Ids == {1, 2}
Sessions == {0, 1, 2} \* 0 represents SQL NULL, not a session.
Statuses == {"claimed", "running", "completed", "failed", "unknown", "skipped_overlap"}
Row == [session : Sessions, status : Statuses]
Active(status) == status \in {"claimed", "running"}
Matching(data, session) == {id \in Ids : data[id].session = session /\ Active(data[id].status)}
Init == /\ rows \in [Ids -> Row] /\ target \in {1, 2} /\ phase = 0
        /\ result = FALSE /\ firstResult = FALSE /\ oracle = FALSE
        /\ cells = 0 /\ payloads = 0
Selected == {id \in Ids :
  (IF Fault = "session" THEN TRUE
   ELSE IF Fault = "null" THEN rows[id].session \in {0, target}
   ELSE rows[id].session = target)
  /\ (IF Fault = "terminal" THEN TRUE
      ELSE IF Fault = "claimed" THEN rows[id].status = "claimed"
      ELSE Active(rows[id].status))}
Probe == /\ phase \in {0, 2}
         /\ result' = IF Fault = "stale" /\ phase = 2 THEN firstResult ELSE (Selected # {})
         /\ firstResult' = IF phase = 0 THEN result' ELSE firstResult
         /\ oracle' = (Matching(rows, target) # {})
         /\ cells' = IF Fault = "payload" THEN 8 * Cardinality(Selected)
                     ELSE IF Selected = {} THEN 0 ELSE 1
         /\ payloads' = IF Fault = "payload" THEN Cardinality(Selected) ELSE 0
         /\ phase' = phase + 1
         /\ UNCHANGED <<rows, target>>
Change == /\ phase = 1
          /\ \E id \in Ids, nextRow \in Row, nextTarget \in {1, 2}:
               /\ rows' = [rows EXCEPT ![id] = nextRow] /\ target' = nextTarget
          /\ phase' = 2
          /\ UNCHANGED <<result, firstResult, oracle, cells, payloads>>
Next == Probe \/ Change
TypeOK == /\ rows \in [Ids -> Row] /\ target \in {1, 2} /\ phase \in 0..3
          /\ result \in BOOLEAN /\ firstResult \in BOOLEAN /\ oracle \in BOOLEAN
          /\ cells \in 0..16 /\ payloads \in 0..2
Equivalent == phase \in {1, 3} => result = oracle
BoundedProjection == phase \in {1, 3} => cells <= 1 /\ payloads = 0
SameOwner == phase \in {1, 3} => (IF result THEN "cron" ELSE "none") = (IF oracle THEN "cron" ELSE "none")
Spec == Init /\ [][Next]_vars
=====================================================================
