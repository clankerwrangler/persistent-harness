-------------------- MODULE MemoryDiagnostics --------------------
\* Sources:
\*   src/kernel.mjs sha256:feb1bec8dc4e3d47d0f11956acacea17cdfac0d91fa853c785f0f050754d06e2
\*   src/extension.mjs sha256:b7e3c99b2fc52d58d7d051eb9b7cda86334f0d577716d8608d0dac9a50da5d60
\*   src/sdk-worker.mjs sha256:46a27a7b8b91f987efe25acee04e34a204c6c8f3cf66772f3d50727a40878e85
\*   src/supervisor.mjs sha256:b1adb2c43e0cc03644b770e2ac9710541f936b7890cfa05efc3e9f0d6fd08df3
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
