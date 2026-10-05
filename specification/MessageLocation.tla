------------------------ MODULE MessageLocation ------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS None, MaxEpoch
VARIABLES epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, acquisitionAge,
          expired, phase, sendEpoch, sendAge, frozen, dispatched, durable, canonical,
          retries, consentAtDispatch
vars == <<epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, acquisitionAge,
          expired, phase, sendEpoch, sendAge, frozen, dispatched, durable, canonical,
          retries, consentAtDispatch>>
Range(seq) == {seq[i] : i \in 1..Len(seq)}
Locations == {"A", "B"}
Empty == [text |-> "genuine text", location |-> None, owner |-> 0]
Init == /\ epoch = 0 /\ enabled = FALSE /\ sample = None /\ fresh = FALSE
        /\ acquisition = FALSE /\ acquisitionEpoch = 0 /\ acquisitionAge = 0 /\ expired = FALSE
        /\ phase = "idle" /\ sendEpoch = 0 /\ sendAge = 0
        /\ frozen = Empty /\ dispatched = <<>> /\ durable = <<>> /\ canonical = <<>>
        /\ retries = <<>> /\ consentAtDispatch = FALSE
Enable == /\ ~enabled /\ epoch < MaxEpoch /\ phase \in {"idle", "sent", "cancelled"}
          /\ epoch' = epoch + 1 /\ enabled' = TRUE /\ sample' = None /\ fresh' = FALSE
          /\ acquisition' = TRUE /\ acquisitionEpoch' = epoch' /\ acquisitionAge' = 0 /\ expired' = FALSE
          /\ UNCHANGED <<phase, sendEpoch, sendAge, frozen, dispatched, durable, canonical, retries, consentAtDispatch>>
Fence(kind) == /\ epoch < MaxEpoch
              /\ epoch' = epoch + 1 /\ enabled' = (IF kind = "cancel" THEN enabled ELSE FALSE)
              /\ sample' = None /\ fresh' = FALSE
              /\ phase' = (IF phase \in {"sampling", "ready"}
                             THEN IF kind = "off" THEN "ready" ELSE "cancelled" ELSE phase)
              /\ UNCHANGED <<acquisition, acquisitionEpoch, acquisitionAge, expired,
                             sendEpoch, sendAge, frozen, dispatched, durable, canonical, retries, consentAtDispatch>>
Result(value) == /\ acquisition /\ acquisition' = FALSE
                 /\ IF acquisitionEpoch = epoch /\ enabled /\ ~expired /\ acquisitionAge < 10
                       THEN /\ sample' = value /\ fresh' = (value # None)
                            /\ phase' = (IF phase = "sampling" /\ sendAge < 2 THEN "ready" ELSE phase)
                       ELSE UNCHANGED <<sample, fresh, phase>>
                 /\ UNCHANGED <<epoch, enabled, acquisitionEpoch, acquisitionAge, expired,
                                sendEpoch, sendAge, frozen, dispatched, durable, canonical, retries, consentAtDispatch>>
ExpireSample == /\ fresh /\ fresh' = FALSE
                /\ UNCHANGED <<epoch, enabled, sample, acquisition, acquisitionEpoch, acquisitionAge,
                               expired, phase, sendEpoch, sendAge, frozen, dispatched, durable, canonical, retries, consentAtDispatch>>
Send == /\ phase = "idle" /\ sendEpoch' = epoch /\ sendAge' = 0
        /\ phase' = (IF enabled /\ ~fresh THEN "sampling" ELSE "ready")
        /\ IF enabled /\ ~fresh /\ (~acquisition \/ acquisitionEpoch # epoch)
              THEN /\ acquisition' = TRUE /\ acquisitionEpoch' = epoch /\ acquisitionAge' = 0 /\ expired' = FALSE
              ELSE UNCHANGED <<acquisition, acquisitionEpoch, acquisitionAge, expired>>
        /\ UNCHANGED <<epoch, enabled, sample, fresh, frozen, dispatched, durable, canonical, retries, consentAtDispatch>>
Tick == /\ (acquisition /\ acquisitionAge < 10) \/ (phase = "sampling" /\ sendAge < 2)
        /\ acquisitionAge' = (IF acquisition /\ acquisitionAge < 10 THEN acquisitionAge + 1 ELSE acquisitionAge)
        /\ sendAge' = (IF phase = "sampling" /\ sendAge < 2 THEN sendAge + 1 ELSE sendAge)
        /\ UNCHANGED <<epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, expired, phase,
                       sendEpoch, frozen, dispatched, durable, canonical, retries, consentAtDispatch>>
AcquisitionDeadline == /\ acquisition /\ acquisitionAge = 10 /\ ~expired /\ expired' = TRUE
                       /\ UNCHANGED <<epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, acquisitionAge,
                                      phase, sendEpoch, sendAge, frozen, dispatched, durable, canonical, retries, consentAtDispatch>>
\* Tick is elapsed time; timer actions can be delayed independently. Result checks both elapsed bounds.
\* Send timeout freezes only that submission. A later, valid opt-in fix may serve a future send.
Dispatch == /\ phase = "ready" \/ (phase = "sampling" /\ sendAge = 2)
            /\ frozen' = [text |-> "genuine text", owner |-> sendEpoch,
                           location |-> IF phase = "ready" /\ enabled /\ epoch = sendEpoch /\ fresh
                                          THEN sample ELSE None]
            /\ dispatched' = <<frozen'>> /\ phase' = "sent"
            /\ consentAtDispatch' = (enabled /\ epoch = sendEpoch /\ fresh)
            /\ UNCHANGED <<epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, acquisitionAge,
                           expired, sendEpoch, sendAge, durable, canonical, retries>>
Admit == /\ Len(dispatched) = 1 /\ Len(durable) = 0 /\ Len(canonical) = 0 /\ durable' = dispatched
         /\ UNCHANGED <<epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, acquisitionAge, expired,
                        phase, sendEpoch, sendAge, frozen, dispatched, canonical, retries, consentAtDispatch>>
Replay == /\ Len(dispatched) = 1 /\ UNCHANGED vars
Commit == /\ Len(durable) = 1 /\ Len(canonical) = 0 /\ canonical' = durable /\ durable' = <<>>
          /\ UNCHANGED <<epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, acquisitionAge, expired,
                         phase, sendEpoch, sendAge, frozen, dispatched, retries, consentAtDispatch>>
RetryOriginal == /\ Len(canonical) = 1 /\ Len(retries) = 0 /\ retries' = canonical
                 /\ UNCHANGED <<epoch, enabled, sample, fresh, acquisition, acquisitionEpoch, acquisitionAge, expired,
                                phase, sendEpoch, sendAge, frozen, dispatched, durable, canonical, consentAtDispatch>>
Next == Enable \/ (\E kind \in {"off", "switch", "cancel"}: Fence(kind)) \/ ExpireSample \/ Send
        \/ Tick \/ AcquisitionDeadline \/ Dispatch \/ Admit \/ Replay \/ Commit \/ RetryOriginal
        \/ (\E value \in Locations \cup {None}: Result(value))
TypeOK == /\ epoch \in 0..MaxEpoch /\ enabled \in BOOLEAN /\ fresh \in BOOLEAN /\ acquisition \in BOOLEAN
          /\ sample \in Locations \cup {None} /\ acquisitionAge \in 0..10 /\ sendAge \in 0..2
          /\ phase \in {"idle", "sampling", "ready", "sent", "cancelled"}
          /\ Len(dispatched) <= 1 /\ Len(durable) <= 1 /\ Len(canonical) <= 1 /\ Len(retries) <= 1
OffDropsSample == ~enabled => sample = None /\ ~fresh
ConsentBound == Len(dispatched) = 1 /\ dispatched[1].location # None => consentAtDispatch
ExactMessage == \A record \in {frozen} \cup Range(dispatched) \cup Range(durable)
                                \cup Range(canonical) \cup Range(retries): record.text = "genuine text"
Immutable == /\ Len(durable) = 1 => durable = dispatched
             /\ Len(canonical) = 1 => canonical = dispatched
             /\ Len(retries) = 1 => retries = canonical
CancelledNeverSends == phase = "cancelled" => Len(dispatched) = 0
Provider(record) == [role |-> "user", text |-> record.text, location |-> record.location]
Public(record) == [role |-> "user", text |-> record.text]
ProjectionBoundary == \A record \in Range(canonical):
                         /\ Provider(record).role = "user"
                         /\ Provider(record).text = Public(record).text
                         /\ ~("location" \in DOMAIN Public(record))
SendProgress == (phase = "sampling") ~> (phase \in {"sent", "cancelled"})

SendDeadlineBound == Len(dispatched) = 1 /\ dispatched[1].location # None => sendAge < 2
LateAcquisitionNoSample == [][(acquisitionAge = 10 /\ (\E value \in Locations \cup {None}: Result(value)))
                              => UNCHANGED <<sample, fresh>>]_vars
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(Dispatch)
=============================================================================
