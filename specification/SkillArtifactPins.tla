----------------------- MODULE SkillArtifactPins -----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Actors, ReadyUsesDesired, SnapshotUsesDesired
Versions == {1, 2}
NoVersion == 0
LegacyHash(v) == "unchanged-source-hash"
VARIABLES source, catalog, staging, stored, desired, phase, pin, loaded, saved, generation, grantFiles
vars == <<source, catalog, staging, stored, desired, phase, pin, loaded, saved, generation, grantFiles>>
Range(f) == {f[a] : a \in Actors} \ {NoVersion}
Init == /\ source = 1 /\ catalog = 0 /\ staging = 0 /\ stored = {}
        /\ desired = [a \in Actors |-> 0] /\ phase = [a \in Actors |-> "absent"]
        /\ pin = [a \in Actors |-> 0] /\ loaded = [a \in Actors |-> 0]
        /\ saved = [a \in Actors |-> 0]
        /\ generation = [a \in Actors |-> 0]
        /\ grantFiles = [a \in Actors |-> [g \in 1..2 |-> 0]]
EditSource == /\ source = 1 /\ source' = 2
              /\ UNCHANGED <<catalog, staging, stored, desired, phase, pin, loaded, saved, generation, grantFiles>>
BeginCapture == /\ staging = 0 /\ source # catalog /\ staging' = source
                /\ UNCHANGED <<source, catalog, stored, desired, phase, pin, loaded, saved, generation, grantFiles>>
\* Publication requires a coherent source witness. An interrupted or changed
\* capture is never installed under its originally expected identity.
Publish == /\ staging # 0 /\ staging = source
           /\ stored' = stored \cup {staging} /\ catalog' = staging /\ staging' = 0
           /\ UNCHANGED <<source, desired, phase, pin, loaded, saved, generation, grantFiles>>
Abandon == /\ staging # 0 /\ staging' = 0
           /\ UNCHANGED <<source, catalog, stored, desired, phase, pin, loaded, saved, generation, grantFiles>>
Reconcile(a) == /\ catalog # 0 /\ desired' = [desired EXCEPT ![a] = catalog]
                /\ UNCHANGED <<source, catalog, staging, stored, phase, pin, loaded, saved, generation, grantFiles>>
\* This is the actual worker-generation admission boundary, not a permanent
\* session grant. Desired authority can continue to reconcile independently.
Prepare(a) == /\ phase[a] = "absent" /\ desired[a] \in stored /\ generation[a] < 2
              /\ generation' = [generation EXCEPT ![a] = @ + 1]
              /\ pin' = [pin EXCEPT ![a] = desired[a]]
              /\ phase' = [phase EXCEPT ![a] = "preparing"]
              /\ UNCHANGED <<source, catalog, staging, stored, desired, loaded, saved, grantFiles>>
PublishGrant(a) == /\ phase[a] = "preparing"
                   /\ grantFiles[a][generation[a]] = 0
                   /\ grantFiles' = [grantFiles EXCEPT ![a][generation[a]] = IF SnapshotUsesDesired THEN desired[a] ELSE pin[a]]
                   /\ phase' = [phase EXCEPT ![a] = "admitted"]
                   /\ UNCHANGED <<source, catalog, staging, stored, desired, pin, loaded, saved, generation>>
Ready(a) == /\ phase[a] = "admitted"
            /\ loaded' = [loaded EXCEPT ![a] = IF ReadyUsesDesired THEN desired[a] ELSE grantFiles[a][generation[a]]]
            /\ saved' = [saved EXCEPT ![a] = pin[a]]
            /\ phase' = [phase EXCEPT ![a] = "idle"]
            /\ UNCHANGED <<source, catalog, staging, stored, desired, pin, generation, grantFiles>>
Busy(a) == /\ phase[a] = "idle" /\ phase' = [phase EXCEPT ![a] = "busy"]
           /\ UNCHANGED <<source, catalog, staging, stored, desired, pin, loaded, saved, generation, grantFiles>>
Idle(a) == /\ phase[a] = "busy" /\ phase' = [phase EXCEPT ![a] = "idle"]
           /\ UNCHANGED <<source, catalog, staging, stored, desired, pin, loaded, saved, generation, grantFiles>>
Retire(a) == /\ phase[a] \in {"idle", "preparing", "admitted"}
             /\ phase' = [phase EXCEPT ![a] = "absent"]
             /\ pin' = [pin EXCEPT ![a] = 0] /\ loaded' = [loaded EXCEPT ![a] = 0]
             /\ UNCHANGED <<source, catalog, staging, stored, desired, saved, generation, grantFiles>>
ForgetSaved(a) == /\ phase[a] = "absent" /\ saved' = [saved EXCEPT ![a] = 0]
                  /\ UNCHANGED <<source, catalog, staging, stored, desired, phase, pin, loaded, generation, grantFiles>>
ForgetGrant(a) == /\ phase[a] = "absent" /\ desired' = [desired EXCEPT ![a] = 0]
                  /\ UNCHANGED <<source, catalog, staging, stored, phase, pin, loaded, saved, generation, grantFiles>>
\* Maintenance only, never an actor-idle or request timer. Initial delivery may
\* omit collection; these guards specify the minimum future deletion boundary.
Collect(v) == /\ v \in stored /\ v # catalog /\ v # staging
              /\ v \notin (Range(desired) \cup Range(pin) \cup Range(saved))
              /\ \A a \in Actors, g \in 1..2: grantFiles[a][g] # v
              /\ stored' = stored \ {v}
              /\ UNCHANGED <<source, catalog, staging, desired, phase, pin, loaded, saved, generation, grantFiles>>
Next == EditSource \/ BeginCapture \/ Publish \/ Abandon
        \/ (\E a \in Actors: Reconcile(a) \/ Prepare(a) \/ PublishGrant(a) \/ Ready(a) \/ Busy(a)
              \/ Idle(a) \/ Retire(a) \/ ForgetSaved(a) \/ ForgetGrant(a))
        \/ (\E v \in Versions: Collect(v))
TypeOK == /\ source \in Versions /\ catalog \in Versions \cup {0}
          /\ staging \in Versions \cup {0} /\ stored \subseteq Versions
          /\ desired \in [Actors -> Versions \cup {0}]
          /\ pin \in [Actors -> Versions \cup {0}]
          /\ loaded \in [Actors -> Versions \cup {0}]
          /\ saved \in [Actors -> Versions \cup {0}]
          /\ phase \in [Actors -> {"absent", "preparing", "admitted", "idle", "busy"}]
          /\ generation \in [Actors -> 0..2]
          /\ grantFiles \in [Actors -> [1..2 -> Versions \cup {0}]]
AllPinsRetained == Range(desired) \cup Range(pin) \cup Range(saved) \subseteq stored
GrantSnapshotPinned == \A a \in Actors: phase[a] \in {"admitted", "idle", "busy"} => grantFiles[a][generation[a]] = pin[a]
GenerationReadsPinned == \A a \in Actors: phase[a] \in {"idle", "busy"} => loaded[a] = pin[a] /\ pin[a] # 0
AbsentHasNoLivePin == \A a \in Actors: phase[a] = "absent" => pin[a] = 0 /\ loaded[a] = 0
SeparateIdentity == LegacyHash(1) = LegacyHash(2) /\ 1 # 2
Spec == Init /\ [][Next]_vars
=============================================================================
