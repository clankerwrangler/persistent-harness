----------------------- MODULE SessionInference -----------------------
\* Sources:
\*   src/actor-coordinator.mjs sha256:d33d75f88913edccec70c1cc2df0391a3e909d958f96acfd890c3b774935ae62
\*   src/store.mjs sha256:82e659225f74f2e93f3b87d4b8fe1d02a50aa8d75c6a90ee51f9b32860e349e6
\*   src/supervisor.mjs sha256:280ac4bdfaca53e29b061ad9d9c74569546e3b8dc0406860b1727e26089df37f
EXTENDS Integers, TLC
CONSTANTS Models, GuardAbort, GuardRevision
VARIABLES serial, desired, active, durableActive, pending, received, applying,
          busy, online, safeWrites, stopped, safeStarts
vars == <<serial, desired, active, durableActive, pending, received, applying,
          busy, online, safeWrites, stopped, safeStarts>>
Init == /\ serial = 0 /\ desired = 0 /\ active = 0 /\ durableActive = 0
        /\ pending = 0 /\ received = 0 /\ applying = [model |-> 0, revision |-> 0]
        /\ busy = FALSE /\ online = TRUE /\ safeWrites = TRUE /\ stopped = FALSE /\ safeStarts = TRUE
Select(m) == /\ serial < 3 /\ m \in Models
             /\ serial' = serial + 1 /\ desired' = m /\ pending' = serial + 1
             /\ durableActive' = IF pending = 0 THEN active ELSE durableActive
             /\ UNCHANGED <<active, received, applying, busy, online, safeWrites, stopped, safeStarts>>
Receive == /\ online /\ received # pending /\ received' = pending
           /\ UNCHANGED <<serial, desired, active, durableActive, pending, applying, busy, online, safeWrites, stopped, safeStarts>>
BeginApply == /\ online /\ ~busy /\ applying.revision = 0 /\ received = pending /\ pending > 0
              /\ applying' = [model |-> desired, revision |-> pending]
              /\ UNCHANGED <<serial, desired, active, durableActive, pending, received, busy, online, safeWrites, stopped, safeStarts>>
Mutate == /\ applying.revision # 0 /\ online /\ active # applying.model
          /\ active' = applying.model
          /\ safeWrites' = (safeWrites /\ ~busy)
          /\ UNCHANGED <<serial, desired, durableActive, pending, received, applying, busy, online, stopped, safeStarts>>
FinishApply == /\ applying.revision # 0 /\ online /\ active = applying.model
               /\ durableActive' = active
               /\ pending' = IF ~GuardRevision \/ applying.revision = pending THEN 0 ELSE pending
               /\ received' = IF ~GuardRevision \/ applying.revision = pending THEN 0 ELSE received
               /\ applying' = [model |-> 0, revision |-> 0]
               /\ UNCHANGED <<serial, desired, active, busy, online, safeWrites, stopped, safeStarts>>
Start == /\ online /\ ~busy /\ applying.revision = 0 /\ pending = 0
         /\ (~GuardAbort \/ ~stopped)
         /\ busy' = TRUE /\ safeStarts' = (safeStarts /\ ~stopped)
         /\ UNCHANGED <<serial, desired, active, durableActive, pending, received, applying, online, safeWrites, stopped>>
End == /\ busy /\ busy' = FALSE
       /\ UNCHANGED <<serial, desired, active, durableActive, pending, received, applying, online, safeWrites, stopped, safeStarts>>
Crash == /\ online /\ online' = FALSE /\ busy' = FALSE /\ applying' = [model |-> 0, revision |-> 0] /\ received' = 0
         /\ UNCHANGED <<serial, desired, active, durableActive, pending, safeWrites, stopped, safeStarts>>
Recover == /\ ~online /\ online' = TRUE /\ active' = durableActive /\ received' = pending /\ desired' = IF pending = 0 THEN durableActive ELSE desired
           /\ UNCHANGED <<serial, durableActive, pending, applying, busy, safeWrites, stopped, safeStarts>>
Abort == /\ ~stopped /\ stopped' = TRUE /\ busy' = FALSE
         /\ UNCHANGED <<serial, desired, active, durableActive, pending, received, applying, online, safeWrites, safeStarts>>
ServiceChange(m) == /\ ~busy /\ online /\ applying.revision = 0 /\ pending = 0 /\ m \in Models
                    /\ active' = m /\ desired' = m
                    /\ UNCHANGED <<serial, durableActive, pending, received, applying, busy, online, safeWrites, stopped, safeStarts>>
Next == (\E m \in Models: Select(m) \/ ServiceChange(m)) \/ Receive \/ BeginApply \/ Mutate \/ FinishApply \/ Start \/ End \/ Crash \/ Recover \/ Abort
Spec == Init /\ [][Next]_vars
TypeOK == /\ desired \in Models /\ active \in Models /\ durableActive \in Models
          /\ pending \in 0..3 /\ serial \in 0..3
SafeBoundary == safeWrites
LatestRetained == pending = 0 => active = desired
PublicActive == IF pending = 0 THEN active ELSE durableActive
AcknowledgedActive == PublicActive \in Models
NoInferenceAfterAbort == safeStarts
=============================================================================
