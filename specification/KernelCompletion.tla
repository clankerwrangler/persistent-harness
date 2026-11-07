-------------------------- MODULE KernelCompletion ---------------------------
\* Sources:
\*   src/kernel.mjs sha256:5ba94932e66bd2da93bf39bb4026b3279aadf0dda1f7f235da2c9af41cfcfb3a
\*   python-runtime/kernel.py sha256:d4aa99006f90d531b546686f6208dc48f77609f4faa00dabb91e7a81f80bc361

\* Done retires execution interruption before output drain. A synchronous
\* snapshot has a fresh caller-owned token; a deferred snapshot has none.
\* Queued timers retain their original process/execution/phase owner.

EXTENDS Naturals, TLC
CONSTANTS RetireOnDone, FenceOwner, HonorDrainAbort, CancelHandledAbort
VARIABLES process, execution, terminal, checkpoint, failure, command, epoch,
          phase, owner, timerOwner, background, aborted, drainAborted,
          completedKilled, staleKilled
vars == <<process, execution, terminal, checkpoint, failure, command, epoch,
          phase, owner, timerOwner, background, aborted, drainAborted,
          completedKilled, staleKilled>>
NoTimer == <<0, 0, "none">>
Init == /\ process = "running" /\ execution = "running" /\ terminal = FALSE
        /\ checkpoint = "none" /\ failure = FALSE /\ command = 1 /\ epoch = 1
        /\ phase = "execute" /\ owner = "execute" /\ timerOwner = NoTimer
        /\ background \in BOOLEAN /\ aborted = FALSE /\ drainAborted = FALSE
        /\ completedKilled = FALSE /\ staleKilled = FALSE
Done == /\ execution = "running" /\ process = "running" /\ ~failure
        /\ execution' = "done" /\ terminal' = TRUE /\ checkpoint' = "pending"
        /\ phase' = "drain" /\ owner' = IF RetireOnDone THEN "none" ELSE owner
        /\ UNCHANGED <<process, failure, command, epoch, timerOwner, background,
                       aborted, drainAborted, completedKilled, staleKilled>>
Interrupt == /\ process = "running" /\ owner # "none" /\ timerOwner = NoTimer
             /\ timerOwner' = <<epoch, command, owner>>
             /\ UNCHANGED <<process, execution, terminal, checkpoint, failure, command, epoch,
                            phase, owner, background, aborted, drainAborted, completedKilled, staleKilled>>
CallerAbort == /\ process = "running" /\ ~aborted
               /\ aborted' = TRUE /\ drainAborted' = (phase = "drain")
               /\ timerOwner' = IF owner # "none" /\ timerOwner = NoTimer
                                  THEN <<epoch, command, owner>> ELSE timerOwner
               /\ UNCHANGED <<process, execution, terminal, checkpoint, failure, command,
                              epoch, phase, owner, background, completedKilled, staleKilled>>
BeginSnapshot == /\ checkpoint = "pending" /\ phase = "drain" /\ process = "running"
                 /\ LET cancelled == ~background /\ HonorDrainAbort
                                      /\ (drainAborted \/ (CancelHandledAbort /\ aborted))
                    IN /\ checkpoint' = IF cancelled THEN "failed" ELSE "saving"
                       /\ phase' = IF cancelled THEN "idle" ELSE "snapshot"
                       /\ owner' = IF cancelled \/ background THEN "none" ELSE "snapshot"
                 /\ UNCHANGED <<process, execution, terminal, failure, command, epoch,
                                timerOwner, background, aborted, drainAborted, completedKilled, staleKilled>>
Timeout == /\ timerOwner # NoTimer
           /\ LET kills == process = "running" /\ owner # "none"
                           /\ (~FenceOwner \/ timerOwner = <<epoch, command, owner>>)
              IN /\ process' = IF kills THEN "killing" ELSE process
                 /\ completedKilled' = (completedKilled \/ (kills /\ phase = "drain"))
                 /\ staleKilled' = (staleKilled \/ (kills /\ timerOwner # <<epoch, command, owner>>))
           /\ timerOwner' = NoTimer
           /\ UNCHANGED <<execution, terminal, checkpoint, failure, command, epoch,
                          phase, owner, background, aborted, drainAborted>>
Fault == /\ execution = "running" /\ ~failure /\ process = "running"
         /\ failure' = TRUE /\ process' = "killing"
         /\ UNCHANGED <<execution, terminal, checkpoint, command, epoch, phase, owner,
                        timerOwner, background, aborted, drainAborted, completedKilled, staleKilled>>
Exit == /\ process \in {"running", "killing"}
        /\ process' = "exited" /\ execution' = "done" /\ terminal' = TRUE
        /\ owner' = "none" /\ phase' = "idle"
        /\ UNCHANGED <<checkpoint, failure, command, epoch, timerOwner, background,
                       aborted, drainAborted, completedKilled, staleKilled>>
Save == /\ checkpoint = "saving" /\ process = "running"
        /\ checkpoint' = "done" /\ phase' = "idle" /\ owner' = "none"
        /\ UNCHANGED <<process, execution, terminal, failure, command, epoch, timerOwner,
                       background, aborted, drainAborted, completedKilled, staleKilled>>
NextExecution == /\ checkpoint \in {"done", "failed"} /\ phase = "idle"
                 /\ process = "running" /\ command = 1
                 /\ command' = 2 /\ execution' = "running" /\ terminal' = FALSE
                 /\ checkpoint' = "none" /\ phase' = "execute" /\ owner' = "execute"
                 /\ aborted' = FALSE /\ drainAborted' = FALSE
                 /\ UNCHANGED <<process, failure, epoch, timerOwner, background, completedKilled, staleKilled>>
Restart == /\ process = "exited" /\ epoch = 1
           /\ epoch' = 2 /\ command' = 1 /\ process' = "running"
           /\ execution' = "running" /\ terminal' = FALSE /\ checkpoint' = "none"
           /\ failure' = FALSE /\ phase' = "execute" /\ owner' = "execute"
           /\ aborted' = FALSE /\ drainAborted' = FALSE
           /\ UNCHANGED <<timerOwner, background, completedKilled, staleKilled>>
Next == Done \/ Interrupt \/ CallerAbort \/ BeginSnapshot \/ Timeout \/ Fault \/ Exit \/ Save \/ NextExecution \/ Restart
Spec == Init /\ [][Next]_vars
CompletionMeansQuiescent == terminal => execution = "done"
FaultWaitsForExit == (failure /\ terminal) => process = "exited"
CompletedExecutionCannotBeKilled == ~completedKilled
TimeoutOwnsExactExecutionAndProcess == ~staleKilled
DrainAbortPreventsSyncSnapshot == (~background /\ drainAborted) => checkpoint # "saving"
HandledExecutionAbortKeepsCheckpoint == (~background /\ aborted /\ ~drainAborted) => checkpoint # "failed"
DeferredSnapshotIsDetached == (background /\ phase = "snapshot") => owner = "none"
=============================================================================
