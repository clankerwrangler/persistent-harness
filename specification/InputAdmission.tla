------------------------- MODULE InputAdmission -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Inputs, StartupBudget, RpcBudget, CoupleStartup, ResetSteering, ExtendWarm
VARIABLES phase, request, stage, receipts, acknowledged, owner, dirty,
          actor, batch, delivered, visibleError, restarts, published, readiness, warm
vars == <<phase, request, stage, receipts, acknowledged, owner, dirty,
          actor, batch, delivered, visibleError, restarts, published, readiness, warm>>
StartupLimit == IF CoupleStartup THEN RpcBudget ELSE StartupBudget
WarmLimit == IF ExtendWarm THEN StartupBudget ELSE RpcBudget
EmptyReadiness == [step |-> "none", age |-> 0, clock |-> 0]
EmptyWarm == [pending |-> FALSE, age |-> 0]
Pending == {i \in Inputs: receipts[i] = 1} \ delivered
Init == /\ phase = "open" /\ request = "none" /\ stage = "none"
        /\ receipts = [i \in Inputs |-> 0] /\ acknowledged = {}
        /\ owner = FALSE /\ dirty = FALSE /\ actor = "cold" /\ batch = {}
        /\ delivered = {} /\ visibleError = FALSE /\ restarts = 0 /\ published = {}
        /\ readiness = EmptyReadiness /\ warm = EmptyWarm
Begin(i) == /\ phase = "open" /\ request = "none" /\ request' = i /\ stage' = "received"
            /\ UNCHANGED <<phase, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, readiness, warm>>
Persist == /\ phase = "open" /\ stage = "received"
           /\ receipts' = [receipts EXCEPT ![request] = 1] /\ stage' = "durable"
           /\ published' = published \cup {request}
           /\ UNCHANGED <<phase, request, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, readiness, warm>>
\* Registration is synchronous. The durable starting marker survives a crash;
\* readiness, skill reconciliation and worker delivery are owned asynchronous work.
Register == /\ phase = "open" /\ stage = "durable"
            /\ owner' = TRUE /\ dirty' = TRUE /\ stage' = "registered"
            /\ actor' = IF actor \in {"cold", "stopped", "error"} THEN "starting" ELSE actor
            /\ visibleError' = FALSE
            /\ readiness' = IF actor \in {"cold", "stopped", "error"} THEN EmptyReadiness ELSE readiness
            /\ UNCHANGED <<phase, request, receipts, acknowledged, batch, delivered, restarts, published, warm>>
Ack == /\ phase = "open" /\ stage = "registered"
       /\ acknowledged' = acknowledged \cup {request} /\ request' = "none" /\ stage' = "none"
       /\ UNCHANGED <<phase, receipts, owner, dirty, actor, batch, delivered, visibleError, restarts, published, readiness, warm>>
\* A synchronous rejection never certifies a wake. The durable receipt remains
\* idempotently retryable; a client disconnect is identical to a lost response.
Reject == /\ stage \in {"received", "durable"} /\ request' = "none" /\ stage' = "none"
          /\ UNCHANGED <<phase, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, readiness, warm>>
\* The durable starting marker precedes the worker's post-spawn clock. Queue
\* waiting is not handshake time. One deadline covers state AND steering ack;
\* nondeterministic completion also represents a hung bootstrap or late ack.
StartHandshake == /\ phase = "open" /\ owner /\ actor = "starting" /\ readiness.step = "none"
                  /\ readiness' = [step |-> "state", age |-> 0, clock |-> 0]
                  /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, warm>>
ColdTick == /\ phase = "open" /\ actor = "starting" /\ readiness.step \in {"state", "steering"}
            /\ readiness.clock < StartupLimit
            /\ readiness' = [readiness EXCEPT !.age = @ + 1, !.clock = @ + 1]
            /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, warm>>
StateReady == /\ phase = "open" /\ actor = "starting" /\ readiness.step = "state"
              /\ readiness.clock < StartupLimit
              /\ readiness' = [readiness EXCEPT !.step = "steering", !.clock = IF ResetSteering THEN 0 ELSE @]
              /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, warm>>
Ready == /\ phase = "open" /\ owner /\ actor = "starting" /\ readiness.step = "steering"
         /\ readiness.clock < StartupLimit /\ actor' = "ready"
         /\ readiness' = [readiness EXCEPT !.step = "ready"]
         /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, batch, delivered, visibleError, restarts, published, warm>>
ColdTimeout == /\ phase = "open" /\ actor = "starting" /\ readiness.step \in {"state", "steering"}
               /\ readiness.clock = StartupLimit
               /\ readiness' = [readiness EXCEPT !.step = "timeout"]
               /\ owner' = FALSE /\ dirty' = FALSE /\ batch' = {} /\ actor' = "error" /\ visibleError' = TRUE
               /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, delivered, restarts, published, warm>>
StartWarm == /\ phase = "open" /\ actor = "ready" /\ ~warm.pending
             /\ warm' = [pending |-> TRUE, age |-> 0]
             /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, readiness>>
WarmTick == /\ phase = "open" /\ actor = "ready" /\ warm.pending /\ warm.age < WarmLimit
            /\ warm' = [warm EXCEPT !.age = @ + 1]
            /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, readiness>>
WarmComplete == /\ phase = "open" /\ actor = "ready" /\ warm.pending
                /\ warm' = EmptyWarm
                /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, readiness>>
Capture == /\ phase = "open" /\ owner /\ dirty /\ actor = "ready" /\ batch = {}
           /\ batch' = Pending /\ dirty' = FALSE
           /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, actor, delivered, visibleError, restarts, published, readiness, warm>>
Deliver(i) == /\ phase = "open" /\ owner /\ actor = "ready" /\ i \in batch
              /\ delivered' = delivered \cup {i} /\ batch' = batch \ {i}
              /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, owner, dirty, actor, visibleError, restarts, published, readiness, warm>>
Finish == /\ owner /\ ~dirty /\ batch = {} /\ owner' = FALSE
          /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, dirty, actor, batch, delivered, visibleError, restarts, published, readiness, warm>>
Fail == /\ phase = "open" /\ owner /\ owner' = FALSE /\ dirty' = FALSE
        /\ batch' = {} /\ actor' = "error" /\ visibleError' = TRUE
        /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, delivered, restarts, published, readiness, warm>>
Shutdown == /\ phase = "open" /\ phase' = "closing" /\ request' = "none" /\ stage' = "none"
            /\ UNCHANGED <<receipts, acknowledged, owner, dirty, actor, batch, delivered, visibleError, restarts, published, readiness, warm>>
Cancel == /\ phase = "closing" /\ owner' = FALSE /\ dirty' = FALSE
          /\ batch' = {} /\ actor' = "stopped"
          /\ UNCHANGED <<phase, request, stage, receipts, acknowledged, delivered, visibleError, restarts, published, readiness, warm>>
Close == /\ phase = "closing" /\ ~owner /\ phase' = "closed" /\ actor' = "stopped"
         /\ UNCHANGED <<request, stage, receipts, acknowledged, owner, dirty, batch, delivered, visibleError, restarts, published, readiness, warm>>
Crash == /\ phase = "open" /\ restarts = 0 /\ phase' = "closed"
         /\ owner' = FALSE /\ dirty' = FALSE /\ batch' = {} /\ request' = "none" /\ stage' = "none"
         /\ UNCHANGED <<receipts, acknowledged, actor, delivered, visibleError, restarts, published, readiness, warm>>
Restart == /\ phase = "closed" /\ restarts = 0 /\ phase' = "open" /\ restarts' = 1
           /\ owner' = (Pending # {}) /\ dirty' = (Pending # {})
           /\ actor' = IF Pending # {} THEN "starting" ELSE "cold"
           /\ readiness' = EmptyReadiness
           /\ UNCHANGED <<request, stage, receipts, acknowledged, batch, delivered, visibleError, published, warm>>
Next == (\E i \in Inputs: Begin(i) \/ Deliver(i)) \/ Persist \/ Register \/ Ack \/ Reject
        \/ StartHandshake \/ ColdTick \/ StateReady \/ Ready \/ ColdTimeout
        \/ StartWarm \/ WarmTick \/ WarmComplete \/ Capture \/ Finish \/ Fail \/ Shutdown \/ Cancel \/ Close \/ Crash \/ Restart
TypeOK == /\ phase \in {"open", "closing", "closed"} /\ receipts \in [Inputs -> 0..1]
          /\ acknowledged \subseteq Inputs /\ published \subseteq Inputs /\ delivered \subseteq Inputs /\ batch \subseteq Inputs
          /\ owner \in BOOLEAN /\ dirty \in BOOLEAN /\ restarts \in 0..1
          /\ readiness.step \in {"none", "state", "steering", "ready", "timeout"}
          /\ readiness.age \in 0..(2 * StartupBudget) /\ readiness.clock \in 0..StartupBudget
          /\ warm.pending \in BOOLEAN /\ warm.age \in 0..StartupBudget
DurableBeforeAck == \A i \in acknowledged: receipts[i] = 1
NoUnownedAcceptance == phase = "open" =>
    ((acknowledged \ delivered) # {} => owner \/ (actor = "error" /\ visibleError))
ClosedDrainsOwner == phase = "closed" => ~owner
NoReadinessAckGate == phase = "open" /\ stage = "registered" => ENABLED Ack
NoReadinessAdmissionGate == phase = "open" /\ request = "none" => \A i \in Inputs: ENABLED Begin(i)
\* Publication is the existing live input-state event, not canonical admission.
VisibleAtAcceptance == Pending \subseteq published
OnlyDurablePublication == \A i \in published: receipts[i] = 1
DeliveryNotTurnEndGated == phase = "open" /\ owner /\ actor = "ready" =>
    \A i \in batch: ENABLED Deliver(i)
OnlyDurableDelivery == \A i \in delivered: receipts[i] = 1
OneHandshakeDeadline == readiness.step = "ready" => readiness.age < StartupBudget
NoEarlyStartupTimeout == readiness.step = "timeout" => readiness.age >= StartupBudget
WarmDeadline == warm.pending => warm.age <= RpcBudget
ColdStep == ColdTick \/ StateReady \/ Ready \/ ColdTimeout
WarmStep == WarmTick \/ WarmComplete
ColdTerminates == (phase = "open" /\ actor = "starting" /\ readiness.step \in {"state", "steering"})
                   ~> (phase # "open" \/ actor # "starting")
WarmTerminates == (phase = "open" /\ actor = "ready" /\ warm.pending)
                   ~> (phase # "open" \/ actor # "ready" \/ ~warm.pending)
Spec == Init /\ [][Next]_vars /\ WF_vars(ColdStep) /\ WF_vars(WarmStep)
=============================================================================
