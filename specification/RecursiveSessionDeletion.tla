------------------- MODULE RecursiveSessionDeletion -------------------
EXTENDS FiniteSets, TLC
CONSTANT Legacy, Selected
Nodes == {"root", "child", "grandchild", "new", "sibling", "other"}
Parent == [s \in Nodes |-> CASE s = "child" -> "root"
  [] s = "grandchild" -> "child" [] s = "new" -> "grandchild"
  [] s = "sibling" -> "root" [] OTHER -> s]
RECURSIVE Below(_, _)
Below(s, r) == s = r \/ (Parent[s] # s /\ Below(Parent[s], r))
VARIABLES admitted, deleted, running, launching, work, phase, scope, artifacts
vars == <<admitted, deleted, running, launching, work, phase, scope, artifacts>>
Available(s) == s \in admitted \ deleted /\ ~(phase = "fenced" /\ s \in scope)
Init == /\ admitted = Nodes \ {"new"}
        /\ deleted = IF Legacy THEN {"child"} ELSE {}
        /\ running = {"grandchild", "sibling", "other"}
        /\ launching = {"root"}
        /\ work = {"grandchild", "other"}
        /\ phase = "idle" /\ scope = {} /\ artifacts = admitted
Admit == /\ Available("grandchild") /\ "new" \notin admitted
         /\ admitted' = admitted \cup {"new"} /\ artifacts' = artifacts \cup {"new"}
         /\ launching' = launching \cup {"new"}
         /\ UNCHANGED <<deleted, running, work, phase, scope>>
Route(s) == /\ Available(s) /\ work' = work \cup {s}
            /\ UNCHANGED <<admitted, deleted, running, launching, phase, scope, artifacts>>
Launch(s) == /\ s \in launching /\ Available(s)
             /\ launching' = launching \ {s} /\ running' = running \cup {s}
             /\ UNCHANGED <<admitted, deleted, work, phase, scope, artifacts>>
Fence == /\ phase = "idle"
         /\ scope' = {s \in admitted : Below(s, Selected)}
         /\ phase' = "fenced"
         /\ UNCHANGED <<admitted, deleted, running, launching, work, artifacts>>
Stop(s) == /\ phase = "fenced" /\ s \in scope
           /\ running' = running \ {s} /\ launching' = launching \ {s}
           /\ UNCHANGED <<admitted, deleted, work, phase, scope, artifacts>>
StopFailure == /\ phase = "fenced" /\ phase' = "idle"
               /\ UNCHANGED <<admitted, deleted, running, launching, work, scope, artifacts>>
Commit == /\ phase = "fenced" /\ scope \cap (running \cup launching) = {}
          /\ deleted' = deleted \cup scope /\ work' = work \ scope
          /\ phase' = "done"
          /\ UNCHANGED <<admitted, running, launching, scope, artifacts>>
Next == Admit \/ Fence \/ StopFailure \/ Commit
        \/ (\E s \in Nodes : Route(s) \/ Launch(s) \/ Stop(s))
Spec == Init /\ [][Next]_vars
TypeOK == /\ admitted \subseteq Nodes /\ deleted \subseteq admitted
          /\ running \subseteq admitted /\ launching \subseteq admitted
          /\ work \subseteq admitted /\ scope \subseteq admitted
          /\ phase \in {"idle", "fenced", "done"}
Retained == artifacts = admitted
ExactScope == phase = "done" => deleted = (IF Legacy THEN {"child"} ELSE {}) \cup scope
CompleteSubtree == phase = "done" =>
  /\ scope = {s \in admitted : Below(s, Selected)}
  /\ scope \subseteq deleted /\ scope \cap (running \cup launching \cup work) = {}
FenceStable == phase = "fenced" => scope = {s \in admitted : Below(s, Selected)}
UnrelatedRunning == {"sibling", "other"} \ {s \in Nodes : Below(s, Selected)} \subseteq running
=============================================================================
