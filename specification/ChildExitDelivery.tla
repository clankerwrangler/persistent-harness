--------------------- MODULE ChildExitDelivery ---------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT MaxGeneration
Generations == 1..MaxGeneration
VARIABLES generation, running, parent, receipts, cancelled, delivered,
          acknowledged, incorporated, inFlight, failed
vars == <<generation, running, parent, receipts, cancelled, delivered,
          acknowledged, incorporated, inFlight, failed>>
Init == /\ generation = 1 /\ running = TRUE /\ parent = "resident"
        /\ receipts = {} /\ cancelled = {} /\ delivered = {}
        /\ acknowledged = {} /\ incorporated = [g \in Generations |-> 0]
        /\ inFlight = {} /\ failed = {}
AbnormalExit == /\ running /\ running' = FALSE
 /\ failed' = failed \cup {generation}
 /\ receipts' = (IF parent = "deleted" THEN receipts ELSE receipts \cup {generation})
 /\ UNCHANGED <<generation,parent,cancelled,delivered,acknowledged,incorporated,inFlight>>
IntentionalExit == /\ running /\ running' = FALSE
 /\ UNCHANGED <<generation,parent,receipts,cancelled,delivered,acknowledged,incorporated,inFlight,failed>>
NewGeneration == /\ ~running /\ generation < MaxGeneration
 /\ generation' = generation + 1 /\ running' = TRUE
 /\ UNCHANGED <<parent,receipts,cancelled,delivered,acknowledged,incorporated,inFlight,failed>>
ParentState == /\ parent # "deleted"
 /\ parent' \in {"resident","passivated","unavailable","deleted"}
 /\ cancelled' = (IF parent' = "deleted" THEN receipts \ acknowledged ELSE cancelled)
 /\ inFlight' = {} /\ UNCHANGED <<generation,running,receipts,delivered,acknowledged,incorporated,failed>>
Dispatch(g) == /\ g \in receipts \ (acknowledged \cup cancelled)
 /\ parent \in {"resident","passivated"} /\ parent' = "resident"
 /\ inFlight' = inFlight \cup {g} /\ delivered' = delivered \cup {g}
 /\ UNCHANGED <<generation,running,receipts,cancelled,acknowledged,incorporated,failed>>
Incorporate(g) == /\ g \in inFlight /\ parent = "resident"
 /\ incorporated' = [incorporated EXCEPT ![g] = 1]
 /\ UNCHANGED <<generation,running,parent,receipts,cancelled,delivered,acknowledged,inFlight,failed>>
Ack(g) == /\ g \in inFlight /\ incorporated[g] = 1
 /\ acknowledged' = acknowledged \cup {g} /\ inFlight' = inFlight \ {g}
 /\ UNCHANGED <<generation,running,parent,receipts,cancelled,delivered,incorporated,failed>>
Restart == /\ inFlight' = {}
 /\ UNCHANGED <<generation,running,parent,receipts,cancelled,delivered,acknowledged,incorporated,failed>>
Next == AbnormalExit \/ IntentionalExit \/ NewGeneration \/ ParentState \/ Restart
        \/ (\E g \in Generations: Dispatch(g) \/ Incorporate(g) \/ Ack(g))
Spec == Init /\ [][Next]_vars
Safety == /\ receipts \subseteq failed
 /\ acknowledged \subseteq delivered /\ delivered \subseteq receipts
 /\ cancelled \subseteq receipts
 /\ (\A g \in Generations: incorporated[g] \in {0,1})
 /\ (\A g \in acknowledged: incorporated[g] = 1)
 /\ (parent = "deleted" => receipts = cancelled \cup acknowledged)
====================================================================
