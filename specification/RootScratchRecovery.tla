---------------------- MODULE RootScratchRecovery ----------------------
EXTENDS TLC
CONSTANT Fault
VARIABLES phase, leaf, baseStable, available, ownership, created, witness,
          repaired, safeCommit
vars == <<phase, leaf, baseStable, available, ownership, created, witness,
          repaired, safeCommit>>
Init == /\ phase = "observe"
        /\ leaf \in {"missing", "owned", "other", "link"}
        /\ baseStable \in BOOLEAN /\ available \in BOOLEAN
        /\ ownership \in {"ready", "deleting", "removed", "invalid"}
        /\ created = FALSE /\ witness = "old"
        /\ repaired = FALSE /\ safeCommit = TRUE
Allowed == baseStable /\ available /\ ownership = "ready"
BeginRepair == /\ phase = "observe" /\ Allowed /\ leaf = "missing"
               /\ Fault # "no-repair" /\ phase' = "mkdir"
               /\ UNCHANGED <<leaf, baseStable, available, ownership, created,
                              witness, repaired, safeCommit>>
ObserveOther == /\ phase = "observe"
                /\ (~Allowed \/ leaf # "missing" \/ Fault = "no-repair")
                /\ phase' = "done"
                /\ UNCHANGED <<leaf, baseStable, available, ownership, created,
                               witness, repaired, safeCommit>>
ExclusiveMkdir == /\ phase = "mkdir"
                  /\ phase' = IF leaf = "missing" \/ Fault = "adopt-race"
                              THEN "verify" ELSE "done"
                  /\ created' = (leaf = "missing")
                  /\ leaf' = IF leaf = "missing" THEN "fresh" ELSE leaf
                  /\ UNCHANGED <<baseStable, available, ownership, witness,
                                 repaired, safeCommit>>
CommitGuard == (baseStable \/ Fault = "skip-base")
               /\ ((available /\ ownership = "ready") \/ Fault = "skip-session")
               /\ ((created /\ leaf = "fresh") \/ Fault = "adopt-race")
Verify == /\ phase = "verify" /\ phase' = "done"
          /\ repaired' = CommitGuard
          /\ witness' = IF CommitGuard THEN "fresh" ELSE witness
          /\ safeCommit' = (~CommitGuard \/ (Allowed /\ created /\ leaf = "fresh"))
          /\ UNCHANGED <<leaf, baseStable, available, ownership, created>>
RaceLeaf == /\ phase \in {"mkdir", "verify"} /\ leaf \in {"missing", "fresh"}
            /\ leaf' \in {"other", "link"}
            /\ UNCHANGED <<phase, baseStable, available, ownership, created,
                           witness, repaired, safeCommit>>
RaceBase == /\ phase \in {"mkdir", "verify"} /\ baseStable
            /\ baseStable' = FALSE
            /\ UNCHANGED <<phase, leaf, available, ownership, created, witness,
                           repaired, safeCommit>>
RaceSession == /\ phase \in {"mkdir", "verify"} /\ available
               /\ available' = FALSE
               /\ UNCHANGED <<phase, leaf, baseStable, ownership, created,
                              witness, repaired, safeCommit>>
RaceOwnership == /\ phase \in {"mkdir", "verify"} /\ ownership = "ready"
                 /\ ownership' \in {"deleting", "removed", "invalid"}
                 /\ UNCHANGED <<phase, leaf, baseStable, available, created,
                                witness, repaired, safeCommit>>
Next == BeginRepair \/ ObserveOther \/ ExclusiveMkdir \/ Verify \/ RaceLeaf
        \/ RaceBase \/ RaceSession \/ RaceOwnership
Spec == Init /\ [][Next]_vars
SafeRepair == safeCommit
WitnessOnlyOnSuccess == (witness = "fresh") = repaired
AvailableRepair == phase = "observe" /\ Allowed /\ leaf = "missing"
                   => ENABLED BeginRepair
=============================================================================
