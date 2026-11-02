---------------------- MODULE ScratchJobIdentity ----------------------
\* Sources:
\*   src/background-notifier.mjs sha256:5a196d023ebf583d7ff892c3d2ea6e648cacb21f61dff1fb5a9e103c216cc4d7
EXTENDS TLC
CONSTANT FreezeIncomplete
RootIdentity == [owner |-> "root", kind |-> "valid", pid |-> "new", birth |-> "new"]
PartialBirth == [owner |-> "root", kind |-> "valid", pid |-> "old", birth |-> "missing"]
PartialKind == [owner |-> "root", kind |-> "missing", pid |-> "old", birth |-> "old"]
PartialPid == [owner |-> "root", kind |-> "valid", pid |-> "missing", birth |-> "old"]
OtherOwner == [RootIdentity EXCEPT !.owner = "other"]
LaterIdentity == [RootIdentity EXCEPT !.pid = "later", !.birth = "later"]
Complete(value) == value.kind = "valid" /\ value.pid # "missing" /\ value.birth # "missing"
VARIABLES phase, published, observed, frozen
vars == <<phase,published,observed,frozen>>
Init == /\ phase = "partial" /\ published \in {PartialBirth, PartialKind, PartialPid}
        /\ observed = published /\ frozen = FALSE
Tamper == /\ phase = "partial" /\ published' = OtherOwner /\ phase' = "tampered"
          /\ UNCHANGED <<observed,frozen>>
PublishRepair == /\ phase \in {"partial","tampered"} /\ published' = RootIdentity /\ phase' = "repaired"
                 /\ UNCHANGED <<observed,frozen>>
Observe ==
  /\ LET candidate == IF frozen \/ published.owner # observed.owner
                        \/ (FreezeIncomplete /\ observed.pid # "missing")
                      THEN observed ELSE published
     IN /\ observed' = candidate /\ frozen' = Complete(candidate)
  /\ UNCHANGED <<phase,published>>
MutateComplete == /\ frozen /\ phase = "repaired" /\ published' = LaterIdentity /\ phase' = "later"
                  /\ UNCHANGED <<observed,frozen>>
Next == Tamper \/ PublishRepair \/ Observe \/ MutateComplete
Spec == Init /\ [][Next]_vars /\ WF_vars(Observe)
StickyOwner == observed.owner = "root"
FrozenIdentity == frozen => observed = RootIdentity
RepairProgress == (phase = "repaired" /\ ~frozen) ~> frozen
=============================================================================
