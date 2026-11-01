-------------------------- MODULE KernelCompletion ---------------------------
\* Sources:
\*   src/kernel.mjs sha256:feb1bec8dc4e3d47d0f11956acacea17cdfac0d91fa853c785f0f050754d06e2
\*   python-runtime/kernel.py sha256:d4aa99006f90d531b546686f6208dc48f77609f4faa00dabb91e7a81f80bc361

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
