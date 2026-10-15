------------------------- MODULE ProcessExitWait -------------------------
EXTENDS Naturals
CONSTANT UnsafeLateListener
VARIABLES phase, alive, listener, received
vars == <<phase, alive, listener, received>>
Init == /\ phase = "running" /\ alive = TRUE /\ listener = FALSE /\ received = FALSE
Listen == /\ ~listener /\ phase \in {"running", "waiting"} /\ listener' = TRUE
          /\ UNCHANGED <<phase, alive, received>>
Terminate == /\ phase = "running" /\ (listener \/ UnsafeLateListener)
             /\ phase' = "terminating" /\ UNCHANGED <<alive, listener, received>>
Exit == /\ phase = "terminating" /\ alive /\ alive' = FALSE /\ received' = listener
        /\ UNCHANGED <<phase, listener>>
Return == /\ phase = "terminating" /\ ~alive /\ phase' = "waiting"
          /\ UNCHANGED <<alive, listener, received>>
Finish == /\ phase = "waiting" /\ received /\ phase' = "done"
          /\ UNCHANGED <<alive, listener, received>>
Next == Listen \/ Terminate \/ Exit \/ Return \/ Finish
AwaitableExit == phase \in {"waiting", "done"} => listener /\ received
Spec == Init /\ [][Next]_vars /\ WF_vars(Listen) /\ WF_vars(Terminate)
        /\ WF_vars(Exit) /\ WF_vars(Return) /\ WF_vars(Finish)
Completes == <> (phase = "done")
=============================================================================
