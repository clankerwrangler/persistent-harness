------------------------ MODULE SnapshotRootAliases ------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
\* Three saved candidates, two source identities. Admission, protection, byte
\* health, group shape, and decode success vary independently for every entry.
VARIABLES phase, i, source, admitted, eligible, healthy, shaped, decodable,
          saved, groups, owners, restored, callbacks, errors, attested
vars == <<phase, i, source, admitted, eligible, healthy, shaped, decodable,
          saved, groups, owners, restored, callbacks, errors, attested>>
Init == /\ phase = "save" /\ i = 1
        /\ source \in {<<1,1,1>>, <<1,1,2>>, <<1,2,1>>}
        /\ admitted \in SUBSET (1..3)
        /\ \E status \in [1..3 -> {"ok", "protected", "missing", "malformed", "unloadable"}]:
            /\ eligible = {j \in 1..3: status[j] # "protected"}
            /\ healthy = {j \in 1..3: status[j] # "missing"}
            /\ shaped = {j \in 1..3: status[j] # "malformed"}
            /\ decodable = {j \in 1..3: status[j] # "unloadable"}
        /\ saved = <<>> /\ groups = <<>> /\ owners = <<>>
        /\ restored = <<>> /\ callbacks = <<>> /\ errors = {} /\ attested = FALSE
FirstRoot(n) == CHOOSE k \in 1..Len(saved):
    /\ source[saved[k]] = source[n]
    /\ \A j \in 1..(k-1): source[saved[j]] # source[n]
Save == /\ phase = "save" /\ i <= 3
        /\ callbacks' = Append(callbacks, i)
        /\ IF i \in admitted
              THEN /\ saved' = Append(saved, i)
                   /\ groups' = Append(groups,
                       IF \E k \in 1..Len(saved): source[saved[k]] = source[i]
                       THEN FirstRoot(i) ELSE Len(saved) + 1)
              ELSE UNCHANGED <<saved, groups>>
        /\ i' = i + 1
        /\ UNCHANGED <<phase, source, admitted, eligible, healthy, shaped,
                       decodable, owners, restored, errors, attested>>
Good(k) == saved[k] \in eligible \cap healthy
Trusted(k) == saved[k] \in shaped /\ saved[groups[k]] \in shaped
Key(k) == IF Trusted(k) THEN groups[k] ELSE k + 3
Prior(k) == {j \in 1..Len(restored): Key(restored[j]) = Key(k)}
BeginRestore == /\ phase = "save" /\ i = 4
                /\ phase' = "restore" /\ i' = 1
                /\ errors' = {k \in 1..Len(saved): ~Trusted(k)}
                /\ attested' = (errors' = {} /\ \A k \in 1..Len(saved): saved[k] \in healthy)
                /\ UNCHANGED <<source, admitted, eligible, healthy, shaped,
                       decodable, saved, groups, owners, restored, callbacks>>
Restore == /\ phase = "restore" /\ i <= Len(saved)
           /\ IF Good(i) /\ (Prior(i) # {} \/ saved[i] \in decodable)
                 THEN /\ restored' = Append(restored, i)
                      /\ owners' = Append(owners,
                           IF Prior(i) = {} THEN i
                           ELSE owners[CHOOSE j \in Prior(i):
                                       \A k \in Prior(i): j <= k])
                 ELSE UNCHANGED <<restored, owners>>
           /\ i' = i + 1
           /\ UNCHANGED <<phase, source, admitted, eligible, healthy, shaped,
                          decodable, saved, groups, callbacks, errors, attested>>
Next == Save \/ BeginRestore \/ Restore
EverySourceDump == phase = "restore" => callbacks = <<1, 2, 3>>
FirstAdmissionOwns == \A k \in 1..Len(saved):
    /\ groups[k] <= k /\ source[saved[groups[k]]] = source[saved[k]]
    /\ \A j \in 1..(groups[k]-1): source[saved[j]] # source[saved[k]]
OnlyHealthyEligible == \A j \in 1..Len(restored): Good(restored[j])
OwnerDecoded == \A j \in 1..Len(owners):
    /\ Good(owners[j]) /\ saved[owners[j]] \in decodable
    /\ owners[j] <= restored[j]
ExactRootAliases == \A j,k \in 1..Len(restored):
    /\ (owners[j] = owners[k]) => (source[saved[restored[j]]] = source[saved[restored[k]]])
    /\ (Trusted(restored[j]) /\ Trusted(restored[k])) =>
        ((source[saved[restored[j]]] = source[saved[restored[k]]]) <=> (owners[j] = owners[k]))
UntrustedIndependent == \A j \in 1..Len(restored):
    ~Trusted(restored[j]) => owners[j] = restored[j]
HealthySalvage == (phase = "restore" /\ i > Len(saved)) =>
    \A k \in 1..Len(saved): (Good(k) /\ saved[k] \in decodable) =>
        \E j \in 1..Len(restored): restored[j] = k
NoMalformedCheckpoint == phase = "restore" =>
    /\ errors = {k \in 1..Len(saved): ~Trusted(k)}
    /\ (errors # {} => ~attested)
Spec == Init /\ [][Next]_vars
=============================================================================
