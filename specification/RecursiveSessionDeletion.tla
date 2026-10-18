------------------- MODULE RecursiveSessionDeletion -------------------
EXTENDS FiniteSets, TLC
CONSTANT Legacy, Selected
Nodes == {"root", "child", "grandchild", "new", "sibling", "other"}
Parent == [s \in Nodes |-> CASE s = "child" -> "root"
  [] s = "grandchild" -> "child" [] s = "new" -> "grandchild"
  [] s = "sibling" -> "root" [] OTHER -> s]
RECURSIVE Below(_, _)
Below(s, r) == s = r \/ (Parent[s] # s /\ Below(Parent[s], r))
VARIABLES admitted, deleted, running, launching, work, phase, scope, artifacts, preflight
vars == <<admitted, deleted, running, launching, work, phase, scope, artifacts, preflight>>
Available(s) == s \in admitted \ deleted /\ ~(phase = "fenced" /\ s \in scope)
Init == /\ preflight="inactive"
        /\ admitted = Nodes \ {"new"}
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
Next == (Admit \/ Fence \/ StopFailure \/ Commit
        \/ (\E s \in Nodes : Route(s) \/ Launch(s) \/ Stop(s))) /\ UNCHANGED preflight
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

\* A transport close is not completion of the held host preflight.
\* The faux fixture supplies pure SDK prerequisites; the store still fences admission.
PreflightInit(fault) ==
  /\ admitted={} /\ deleted={} /\ running={} /\ launching={} /\ work={}
  /\ phase="inactive" /\ scope={} /\ artifacts={}
  /\ \E deleteFirst \in BOOLEAN:
    preflight=[fault |-> fault, deleteFirst |-> deleteFirst, stage |-> "held",
      parentDeleted |-> FALSE, clientClosed |-> FALSE, sdkReady |-> fault#"missing-sdk",
      storeAttempts |-> 0, denied |-> FALSE, childAdmitted |-> FALSE,
      files |-> 0, hostDone |-> FALSE, observed |-> FALSE]
PreflightDelete == /\ preflight.stage="held" /\ preflight.deleteFirst /\ ~preflight.parentDeleted
  /\ preflight'=[preflight EXCEPT !.parentDeleted=TRUE, !.clientClosed=TRUE]
PreflightRelease == /\ preflight.stage="held"
  /\ (~preflight.deleteFirst \/ preflight.parentDeleted)
  /\ preflight'=[preflight EXCEPT !.stage="context"]
PreflightContext == /\ preflight.stage="context"
  /\ preflight'=[preflight EXCEPT !.stage=IF preflight.sdkReady THEN "initialize" ELSE "done",
      !.hostDone=~preflight.sdkReady]
PreflightInitialize == /\ preflight.stage="initialize"
  /\ preflight'=[preflight EXCEPT !.files=3, !.stage="admit"]
PreflightAdmit == /\ preflight.stage="admit"
  /\ LET deny == preflight.parentDeleted /\ preflight.fault#"skip-fence"
     IN preflight'=[preflight EXCEPT !.storeAttempts=1, !.denied=deny,
          !.childAdmitted=~deny, !.stage=IF deny THEN "cleanup" ELSE "done", !.hostDone=~deny]
PreflightCleanup == /\ preflight.stage="cleanup"
  /\ preflight'=[preflight EXCEPT !.files=IF preflight.fault="leak-transient" THEN @ ELSE 0,
      !.stage="done", !.hostDone=TRUE]
PreflightObserveHost == /\ preflight.hostDone /\ ~preflight.observed
  /\ preflight'=[preflight EXCEPT !.observed=TRUE]
PreflightObserveClient == /\ preflight.fault="early-observe" /\ preflight.clientClosed /\ ~preflight.observed
  /\ preflight'=[preflight EXCEPT !.observed=TRUE]
PreflightNext ==
  /\ (PreflightDelete \/ PreflightRelease \/ PreflightContext \/ PreflightInitialize
      \/ PreflightAdmit \/ PreflightCleanup \/ PreflightObserveHost \/ PreflightObserveClient)
  /\ UNCHANGED <<admitted,deleted,running,launching,work,phase,scope,artifacts>>
PreflightSpec == PreflightInit("none") /\ [][PreflightNext]_vars
PreflightMissingSdkSpec == PreflightInit("missing-sdk") /\ [][PreflightNext]_vars
PreflightEarlyObserveSpec == PreflightInit("early-observe") /\ [][PreflightNext]_vars
PreflightSkipFenceSpec == PreflightInit("skip-fence") /\ [][PreflightNext]_vars
PreflightLeakTransientSpec == PreflightInit("leak-transient") /\ [][PreflightNext]_vars
PreflightReachesStore == preflight.hostDone => preflight.storeAttempts=1
PreflightWaitsHost == preflight.observed => preflight.hostDone
PreflightNoDeletedAdmission == ~(preflight.parentDeleted /\ preflight.childAdmitted)
PreflightDeniedCleanup == preflight.hostDone /\ preflight.denied => preflight.files=0

=============================================================================
