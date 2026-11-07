-------------------- MODULE MemoryDiagnostics --------------------
\* Sources:
\*   src/kernel.mjs sha256:5ba94932e66bd2da93bf39bb4026b3279aadf0dda1f7f235da2c9af41cfcfb3a
\*   src/extension.mjs sha256:3a89d6dfc805a979efe720e1a242f9e5c515a5f98cf3c043a0c3994ba7b41567
\*   src/sdk-worker.mjs sha256:ad3637bdce0be9028c01b99eb3b0c619d76473b0def01bae88de50127622ea0a
\*   src/supervisor.mjs sha256:d36114a792306b8a4c89883a9ded1eda12230bd61ee37e210cbee26efc7e28b4
\*   src/protocol.mjs sha256:f19f3f025a9c8e60d6a3241d9a0c7b0283f56b5de283560028579b24a9d6a446
EXTENDS Naturals, TLC
CONSTANT IgnoreBusy, StartMissing, SkipReserve, MutateRead, BypassAuth
VARIABLES worker, kernel, queued, draining, phase, allowed, sends, unsafe,
          startedByRead, changedByRead, acceptedIdle, reserved
vars == <<worker,kernel,queued,draining,phase,allowed,sends,unsafe,
          startedByRead,changedByRead,acceptedIdle,reserved>>
Init == /\ worker \in BOOLEAN /\ kernel \in {"absent","idle","tool","host","snapshot"}
        /\ queued \in BOOLEAN /\ draining = FALSE /\ allowed \in BOOLEAN
        /\ phase = "new" /\ sends = 0 /\ unsafe = FALSE
        /\ startedByRead = FALSE /\ changedByRead = FALSE
        /\ acceptedIdle = TRUE /\ reserved = FALSE
Forward == /\ phase = "new" /\ phase' = "forwarded"
           /\ UNCHANGED <<worker,kernel,queued,draining,allowed,sends,unsafe,
                           startedByRead,changedByRead,acceptedIdle,reserved>>
Receive == /\ phase = "forwarded"
           /\ LET eligible == (allowed \/ BypassAuth) /\ ~draining /\ (worker \/ StartMissing)
                               /\ (kernel = "idle" \/ (IgnoreBusy /\ kernel \in {"tool","host","snapshot"}) \/ (kernel = "absent" /\ StartMissing))
                               /\ (~queued \/ IgnoreBusy)
              IN /\ phase' = IF eligible THEN "reading" ELSE "done"
                 /\ sends' = IF eligible THEN sends + 1 ELSE sends
                 /\ unsafe' = (unsafe \/ (eligible /\ (~allowed \/ kernel \in {"tool","host","snapshot"})))
                 /\ acceptedIdle' = (~eligible \/ (kernel = "idle" /\ ~queued /\ ~draining))
                 /\ startedByRead' = (startedByRead \/ (eligible /\ (~worker \/ kernel = "absent")))
                 /\ changedByRead' = (changedByRead \/ (eligible /\ MutateRead))
                 /\ reserved' = (eligible /\ ~SkipReserve)
                 /\ kernel' = IF eligible /\ ~SkipReserve THEN "diagnostic" ELSE kernel
           /\ UNCHANGED <<worker,queued,draining,allowed>>
Wake == /\ ~queued /\ queued' = TRUE
        /\ UNCHANGED <<worker,kernel,draining,phase,allowed,sends,unsafe,startedByRead,changedByRead,acceptedIdle,reserved>>
BeginWork == /\ queued /\ kernel = "idle" /\ ~draining
             /\ kernel' = "tool" /\ queued' = FALSE
             /\ unsafe' = (unsafe \/ (phase = "reading"))
             /\ UNCHANGED <<worker,draining,phase,allowed,sends,startedByRead,changedByRead,acceptedIdle,reserved>>
Drain == /\ ~draining /\ draining' = TRUE
         /\ UNCHANGED <<worker,kernel,queued,phase,allowed,sends,unsafe,startedByRead,changedByRead,acceptedIdle,reserved>>
Complete == /\ phase = "reading" /\ phase' = "done"
            /\ kernel' = (IF reserved THEN "idle" ELSE kernel) /\ reserved' = FALSE
            /\ UNCHANGED <<worker,queued,draining,allowed,sends,unsafe,startedByRead,changedByRead,acceptedIdle>>
Next == Forward \/ Receive \/ Wake \/ BeginWork \/ Drain \/ Complete
Spec == Init /\ [][Next]_vars
SafePipeAndScope == ~unsafe
NoStart == ~startedByRead
NoMutation == ~changedByRead
ImmediateBusy == phase = "reading" => acceptedIdle
=============================================================================
