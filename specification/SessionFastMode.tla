---------------------------- MODULE SessionFastMode ----------------------------
EXTENDS Naturals
CONSTANT Sessions
VARIABLES durable, supported, phase, sampled, tier, costTier, activeTier, view, readOK, route
vars == <<durable, supported, phase, sampled, tier, costTier, activeTier, view, readOK, route>>
Init == /\ durable = [s \in Sessions |-> FALSE]
        /\ supported \in [Sessions -> BOOLEAN]
        /\ phase = [s \in Sessions |-> "idle"]
        /\ sampled = [s \in Sessions |-> FALSE]
        /\ tier = [s \in Sessions |-> "auto"]
        /\ costTier = tier /\ activeTier = tier /\ view = durable
        /\ readOK = [s \in Sessions |-> FALSE]
        /\ route = [s \in Sessions |-> "simple"]
Set(s, enabled) == /\ durable' = [durable EXCEPT ![s] = enabled]
                   /\ UNCHANGED <<supported, phase, sampled, tier, costTier, activeTier, view, readOK, route>>
Refresh(s) == /\ view' = [view EXCEPT ![s] = durable[s]]
              /\ UNCHANGED <<durable, supported, phase, sampled, tier, costTier, activeTier, readOK, route>>
\* A durable read is the request-start cutoff. Failure cannot route a stale tier.
Start(s) == /\ phase[s] = "idle"
            /\ phase' = [phase EXCEPT ![s] = "streaming"]
            /\ sampled' = [sampled EXCEPT ![s] = durable[s]]
            /\ tier' = [tier EXCEPT ![s] = IF durable[s] /\ supported[s] THEN "priority" ELSE "auto"]
            /\ costTier' = [costTier EXCEPT ![s] = tier'[s]]
            /\ activeTier' = [activeTier EXCEPT ![s] = tier'[s]]
            /\ readOK' = [readOK EXCEPT ![s] = TRUE]
            /\ route' = [route EXCEPT ![s] = IF durable[s] /\ supported[s] THEN "detailed" ELSE "simple"]
            /\ UNCHANGED <<durable, supported, view>>
ReadFailure(s) == /\ phase[s] = "idle" /\ UNCHANGED vars
Finish(s) == /\ phase[s] = "streaming"
             /\ phase' = [phase EXCEPT ![s] = "idle"]
             /\ UNCHANGED <<durable, supported, sampled, tier, costTier, activeTier, view, readOK, route>>
ChangeModel(s) == /\ phase[s] = "idle"
                  /\ supported' = [supported EXCEPT ![s] = ~@]
                  /\ UNCHANGED <<durable, phase, sampled, tier, costTier, activeTier, view, readOK, route>>
Next == \E s \in Sessions: (\E enabled \in BOOLEAN: Set(s, enabled)) \/ Refresh(s) \/ Start(s) \/ ReadFailure(s) \/ Finish(s) \/ ChangeModel(s)
TypeOK == durable \in [Sessions -> BOOLEAN] /\ view \in [Sessions -> BOOLEAN]
TierAndCostAgree == tier = costTier
StreamUnaffected == \A s \in Sessions: phase[s] = "streaming" => tier[s] = activeTier[s]
Gated == \A s \in Sessions: phase[s] = "streaming" => (tier[s] = "priority" <=> sampled[s] /\ supported[s])
NoStaleReadDispatch == \A s \in Sessions: phase[s] = "streaming" => readOK[s]
\* Pinned stock simple options discard serviceTier. Only the detailed public
\* stream path (also used by the native adapter) carries it into wire and cost.
DetailedForPriority == \A s \in Sessions: phase[s] = "streaming" /\ tier[s] = "priority" => route[s] = "detailed"
Spec == Init /\ [][Next]_vars
===============================================================================
