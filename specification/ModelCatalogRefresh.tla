-------------------------- MODULE ModelCatalogRefresh --------------------------
EXTENDS Naturals
CONSTANT Requests
VARIABLES phase, operation, outcome, result, warning, networkPolicy, deadline, selection
vars == <<phase, operation, outcome, result, warning, networkPolicy, deadline, selection>>
Init == /\ phase = [r \in Requests |-> "new"]
        /\ operation \in [Requests -> {"picker", "search", "pin"}]
        /\ outcome \in [Requests -> {"fresh", "failure", "timeout"}]
        /\ result = [r \in Requests |-> {}]
        /\ warning = [r \in Requests |-> FALSE]
        /\ networkPolicy = [r \in Requests |-> "unset"]
        /\ deadline = [r \in Requests |-> 0] /\ selection = "current"
Call(r) == /\ phase[r] = "new" /\ phase' = [phase EXCEPT ![r] = "refreshing"]
           /\ networkPolicy' = [networkPolicy EXCEPT ![r] = IF operation[r] = "pin" THEN "false" ELSE "stock"]
           /\ deadline' = [deadline EXCEPT ![r] = 15000]
           /\ UNCHANGED <<operation, outcome, result, warning, selection>>
\* Pi owns cache restoration, partial publication, and cancellation. The adapter
\* reads its snapshot only after refresh settles and never selects a model.
Return(r) == /\ phase[r] = "refreshing" /\ phase' = [phase EXCEPT ![r] = "done"]
             /\ result' = [result EXCEPT ![r] = IF outcome[r] = "fresh" THEN {"cached", "new"} ELSE {"cached"}]
             /\ warning' = [warning EXCEPT ![r] = (outcome[r] # "fresh")]
             /\ UNCHANGED <<operation, outcome, networkPolicy, deadline, selection>>
Next == (\E r \in Requests: Call(r) \/ Return(r))
        \/ ((\A r \in Requests: phase[r] = "done") /\ UNCHANGED vars)
PolicyDelegated == \A r \in Requests: phase[r] # "new" => networkPolicy[r] = IF operation[r] = "pin" THEN "false" ELSE "stock"
BoundPassed == \A r \in Requests: phase[r] # "new" => deadline[r] = 15000
NoDefaultChange == selection = "current"
FallbackVisible == \A r \in Requests: phase[r] = "done" => "cached" \in result[r]
FailureVisible == \A r \in Requests: phase[r] = "done" => warning[r] = (outcome[r] # "fresh")
Spec == Init /\ [][Next]_vars
===============================================================================
