-------------------------- MODULE KernelCompletion ---------------------------
EXTENDS Naturals
VARIABLES process, execution, terminal, checkpoint, failure
vars == <<process, execution, terminal, checkpoint, failure>>
Init == /\ process = "running" /\ execution = "running" /\ terminal = FALSE
        /\ checkpoint = "none" /\ failure = FALSE
Done == /\ execution = "running" /\ ~failure
        /\ execution' = "done" /\ terminal' = TRUE /\ checkpoint' = "pending"
        /\ UNCHANGED <<process, failure>>
Fault == /\ execution = "running" /\ ~failure
         /\ failure' = TRUE /\ process' = "killing"
         /\ UNCHANGED <<execution, terminal, checkpoint>>
Exit == /\ process \in {"running", "killing"}
        /\ process' = "exited" /\ execution' = "done" /\ terminal' = TRUE
        /\ UNCHANGED <<checkpoint, failure>>
Save == /\ checkpoint = "pending" /\ checkpoint' = "done"
        /\ UNCHANGED <<process, execution, terminal, failure>>
Next == Done \/ Fault \/ Exit \/ Save
Spec == Init /\ [][Next]_vars
CompletionMeansQuiescent == terminal => execution = "done"
FaultWaitsForExit == (failure /\ terminal) => process = "exited"
=============================================================================
