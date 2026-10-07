------------------------- MODULE InputAdmission -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Inputs
VARIABLES phase, request, stage, receipts, acknowledged, owner, dirty,
          actor, batch, delivered, visibleError, restarts
vars == <<phase, request, stage, receipts, acknowledged, owner, dirty,
          actor, batch, delivered, visibleError, restarts>>
Pending == {i \in Inputs: receipts[i] = 1} \ delivered
Init == /\ phase = "open" /\ request = "none" /\ stage = "none"
        /\ receipts = [i \in Inputs |-> 0] /\ acknowledged = {}
        /\ owner = FALSE /\ dirty = FALSE /\ actor = "cold" /\ batch = {}
        /\ delivered = {} /\ visibleError = FALSE /\ restarts = 0
Begin(i) == /\ phase = "open" /\ request = "none" /\ request' = i /\ stage' = "received"
            /\ UNCHANGED <<phase, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts>>
Persist == /\ phase = "open" /\ stage = "received"
           /\ receipts' = [receipts EXCEPT ![request] = 1] /\ stage' = "durable"
           /\ UNCHANGED <<phase, request, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts>>
\* Registration is synchronous. The durable starting marker survives a crash;
\* readiness, skill reconciliation and worker delivery are owned asynchronous work.
Register == /\ phase = "open" /\ stage = "durable"
            /\ owner' = TRUE /\ dirty' = TRUE /\ stage' = "registered"
            /\ actor' = IF actor \in {"cold", "stopped", "error"} THEN "starting" ELSE actor
            /\ visibleError' = FALSE
            /\ UNCHANGED <<phase, request, receipts, acknowledged, batch, delivered, restarts>>
Ack == /\ phase = "open" /\ stage = "registered"
       /\ acknowledged' = acknowledged \cup {request} /\ request' = "none" /\ stage' = "none"
       /\ UNCHANGED <<phase, receipts, owner, dirty, actor, batch, delivered, visibleError, restarts>>
\* A synchronous rejection never certifies a wake. The durable receipt remains
\* idempotently retryable; a client disconnect is identical to a lost response.
Reject == /\ stage \in {"received", "durable"} /\ request' = "none" /\ stage' = "none"
          /\ UNCHANGED <<phase, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts>>
Ready == /\ phase = "open" /\ owner /\ actor \in {"cold", "starting"}
         /\ actor' = "ready"
         /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, batch, delivered, visibleError, restarts>>
Capture == /\ phase = "open" /\ owner /\ dirty /\ actor = "ready" /\ batch = {}
           /\ batch' = Pending /\ dirty' = FALSE
           /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, actor, delivered, visibleError, restarts>>
Deliver(i) == /\ phase = "open" /\ owner /\ actor = "ready" /\ i \in batch
              /\ delivered' = delivered \cup {i} /\ batch' = batch \ {i}
              /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, visibleError, restarts>>
Finish == /\ owner /\ ~dirty /\ batch = {} /\ owner' = FALSE
          /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, dirty, actor, batch, delivered, visibleError, restarts>>
Fail == /\ phase = "open" /\ owner /\ owner' = FALSE /\ dirty' = FALSE
        /\ batch' = {} /\ actor' = "error" /\ visibleError' = TRUE
        /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, delivered, restarts>>
Shutdown == /\ phase = "open" /\ phase' = "closing" /\ request' = "none" /\ stage' = "none"
            /\ UNCHANGED <<receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts>>
Cancel == /\ phase = "closing" /\ owner' = FALSE /\ dirty' = FALSE
          /\ batch' = {} /\ actor' = "stopped"
          /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, delivered, visibleError, restarts>>
Close == /\ phase = "closing" /\ ~owner /\ phase' = "closed" /\ actor' = "stopped"
         /\ UNCHANGED <<request, stage, receipts, acknowledged, owner, dirty, batch, delivered, visibleError, restarts>>
Crash == /\ phase = "open" /\ restarts = 0 /\ phase' = "closed"
         /\ owner' = FALSE /\ dirty' = FALSE /\ batch' = {} /\ request' = "none" /\ stage' = "none"
         /\ UNCHANGED <<receipts, acknowledged, actor, delivered, visibleError, restarts>>
Restart == /\ phase = "closed" /\ restarts = 0 /\ phase' = "open" /\ restarts' = 1
           /\ owner' = (Pending # {}) /\ dirty' = (Pending # {})
           /\ actor' = IF Pending # {} THEN "starting" ELSE "cold"
           /\ UNCHANGED <<request, stage, receipts, acknowledged, batch, delivered, visibleError>>
Next == (\E i \in Inputs: Begin(i) \/ Deliver(i)) \/ Persist \/ Register \/ Ack \/ Reject
        \/ Ready \/ Capture \/ Finish \/ Fail \/ Shutdown \/ Cancel \/ Close \/ Crash \/ Restart
TypeOK == /\ phase \in {"open", "closing", "closed"} /\ receipts \in [Inputs -> 0..1]
          /\ acknowledged \subseteq Inputs /\ delivered \subseteq Inputs /\ batch \subseteq Inputs
          /\ owner \in BOOLEAN /\ dirty \in BOOLEAN /\ restarts \in 0..1
DurableBeforeAck == \A i \in acknowledged: receipts[i] = 1
NoUnownedAcceptance == phase = "open" =>
    ((acknowledged \ delivered) # {} => owner \/ (actor = "error" /\ visibleError))
ClosedDrainsOwner == phase = "closed" => ~owner
NoReadinessAckGate == phase = "open" /\ stage = "registered" => ENABLED Ack
NoReadinessAdmissionGate == phase = "open" /\ request = "none" => \A i \in Inputs: ENABLED Begin(i)
OnlyDurableDelivery == \A i \in delivered: receipts[i] = 1
Spec == Init /\ [][Next]_vars
=============================================================================
