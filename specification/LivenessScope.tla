----------------------------- MODULE LivenessScope -----------------------------
EXTENDS Naturals
VARIABLES operation, peer, phase, audits, launches, available, registered, heartbeatOK
vars == <<operation, peer, phase, audits, launches, available, registered, heartbeatOK>>
Peers == {"new", "legacy-unknown-request", "absent", "invalid", "timeout", "wrong-request", "remote-enoent", "remote-refused"}
Compatible == {"new", "legacy-unknown-request"}
Init == /\ operation \in {"ensure", "status", "heartbeat"}
        /\ peer \in Peers /\ phase = "start" /\ audits = 0 /\ launches = 0
        /\ available = FALSE /\ registered \in BOOLEAN /\ heartbeatOK = FALSE
Probe == /\ operation = "ensure" /\ phase \in {"start", "locked", "waiting"}
         /\ phase' = IF peer \in Compatible THEN "done"
                      ELSE IF peer = "absent" THEN IF phase = "start" THEN "lock" ELSE "launch"
                      ELSE "failed"
         /\ available' = (peer \in Compatible)
         /\ UNCHANGED <<operation, peer, audits, launches, registered, heartbeatOK>>
\* A concurrent starter can appear before the second probe under the start lock.
Lock == /\ phase = "lock" /\ phase' = "locked" /\ peer' \in Peers
        /\ UNCHANGED <<operation, audits, launches, available, registered, heartbeatOK>>
Launch == /\ phase = "launch" /\ peer = "absent" /\ launches = 0
          /\ launches' = 1 /\ phase' = "waiting" /\ peer' = "new"
          /\ UNCHANGED <<operation, audits, available, registered, heartbeatOK>>
Status == /\ operation = "status" /\ phase = "start" /\ phase' = "done" /\ audits' = 1
          /\ UNCHANGED <<operation, peer, launches, available, registered, heartbeatOK>>
Heartbeat == /\ operation = "heartbeat" /\ phase = "start" /\ phase' = "done"
             /\ heartbeatOK' = registered
             /\ UNCHANGED <<operation, peer, audits, launches, available, registered>>
Next == Probe \/ Lock \/ Launch \/ Status \/ Heartbeat
ProbeDoesNotAudit == operation = "ensure" => audits = 0
OnlyAbsenceLaunches == phase = "launch" => peer = "absent"
NoDuplicateLaunch == launches <= 1
ProtocolEvidenceRequired == available => peer \in Compatible
BadProtocolFails == operation = "ensure" /\ phase = "failed" => ~available /\ launches = 0
ExplicitStatusAudits == operation = "status" /\ phase = "done" => audits = 1
HeartbeatStillRegistered == heartbeatOK => registered
Spec == Init /\ [][Next]_vars
===============================================================================
