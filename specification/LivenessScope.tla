----------------------------- MODULE LivenessScope -----------------------------
EXTENDS Naturals
CONSTANTS EagerSupervisor, EagerClient, MissingStartImport
VARIABLES operation, peer, phase, audits, launches, available, registered, heartbeatOK,
          supervisorLoaded, clientLoaded, childSupervisorLoaded, started, diagnostics, subscriptions
vars == <<operation,peer,phase,audits,launches,available,registered,heartbeatOK,
          supervisorLoaded,clientLoaded,childSupervisorLoaded,started,diagnostics,subscriptions>>
Peers == {"new","legacy-unknown-request","absent","invalid","timeout","wrong-request","remote-enoent","remote-refused"}
Compatible == {"new","legacy-unknown-request"}
Init == /\ operation \in {"ensure","status","heartbeat","memory","start","shutdown","import","invalid"}
        /\ peer \in Peers /\ phase="start" /\ audits=0 /\ launches=0
        /\ available=FALSE /\ registered \in BOOLEAN /\ heartbeatOK=FALSE
        /\ supervisorLoaded=EagerSupervisor /\ clientLoaded=EagerClient
        /\ childSupervisorLoaded=FALSE /\ started=FALSE /\ diagnostics=0 /\ subscriptions=0
Probe == /\ operation="ensure" /\ phase \in {"start","locked","waiting"}
         /\ phase'=IF peer \in Compatible THEN "done"
              ELSE IF peer="absent" THEN IF phase="start" THEN "lock" ELSE "launch" ELSE "failed"
         /\ available'=(peer \in Compatible)
         /\ UNCHANGED <<operation,peer,audits,launches,registered,heartbeatOK,
              supervisorLoaded,clientLoaded,childSupervisorLoaded,started,diagnostics,subscriptions>>
\* A concurrent starter can appear before the second probe under the start lock.
Lock == /\ phase="lock" /\ phase'="locked" /\ peer' \in Peers
        /\ UNCHANGED <<operation,audits,launches,available,registered,heartbeatOK,
             supervisorLoaded,clientLoaded,childSupervisorLoaded,started,diagnostics,subscriptions>>
Launch == /\ phase="launch" /\ peer="absent" /\ launches=0
          /\ launches'=1 /\ phase'="waiting" /\ peer'="new"
          /\ childSupervisorLoaded'=~MissingStartImport
          /\ UNCHANGED <<operation,audits,available,registered,heartbeatOK,
               supervisorLoaded,clientLoaded,started,diagnostics,subscriptions>>
Status == /\ operation="status" /\ phase="start" /\ phase'="done" /\ audits'=1
          /\ UNCHANGED <<operation,peer,launches,available,registered,heartbeatOK,
               supervisorLoaded,clientLoaded,childSupervisorLoaded,started,diagnostics,subscriptions>>
Heartbeat == /\ operation="heartbeat" /\ phase="start" /\ phase'="done" /\ heartbeatOK'=registered
             /\ UNCHANGED <<operation,peer,audits,launches,available,registered,
                  supervisorLoaded,clientLoaded,childSupervisorLoaded,started,diagnostics,subscriptions>>
Memory == /\ operation="memory" /\ phase="start" /\ phase'="done" /\ clientLoaded'=TRUE /\ diagnostics'=1
          /\ UNCHANGED <<operation,peer,audits,launches,available,registered,heartbeatOK,
               supervisorLoaded,childSupervisorLoaded,started,subscriptions>>
Start == /\ operation="start" /\ phase="start" /\ phase'="done"
         /\ supervisorLoaded'=~MissingStartImport /\ started'=~MissingStartImport
         /\ UNCHANGED <<operation,peer,audits,launches,available,registered,heartbeatOK,
              clientLoaded,childSupervisorLoaded,diagnostics,subscriptions>>
NoService == /\ operation \in {"shutdown","import","invalid"} /\ phase="start" /\ phase'="done"
             /\ UNCHANGED <<operation,peer,audits,launches,available,registered,heartbeatOK,
                  supervisorLoaded,clientLoaded,childSupervisorLoaded,started,diagnostics,subscriptions>>
Next == Probe \/ Lock \/ Launch \/ Status \/ Heartbeat \/ Memory \/ Start \/ NoService
ProbeDoesNotAudit == operation="ensure" => audits=0
OnlyAbsenceLaunches == phase="launch" => peer="absent"
NoDuplicateLaunch == launches<=1
ProtocolEvidenceRequired == available => peer \in Compatible
BadProtocolFails == operation="ensure" /\ phase="failed" => ~available /\ launches=0
ExplicitStatusAudits == operation="status" /\ phase="done" => audits=1
HeartbeatStillRegistered == heartbeatOK => registered
NoUnusedSupervisor == operation # "start" => ~supervisorLoaded
NoUnusedClient == operation # "memory" => ~clientLoaded
ExplicitStartSupported == operation="start" /\ phase="done" => supervisorLoaded /\ started
EnsureChildStillStarts == launches=1 => childSupervisorLoaded
DiagnosticConnectOnly == operation="memory" => launches=0 /\ subscriptions=0 /\ audits=0
Spec == Init /\ [][Next]_vars
===============================================================================
