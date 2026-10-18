----------------------- MODULE SharedBroadcast -----------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANT Fault
Clients == {1, 2}
Frames == {1, 2}
Size(b) == IF b = 1 THEN 2 ELSE 1
Limit == 3
RECURSIVE QBytes(_)
QBytes(q) == IF Len(q) = 0 THEN 0 ELSE Size(Head(q)) + QBytes(Tail(q))
VARIABLES live, blocked, queue, logicalBytes, wire, admitted, b, phase,
          cursor, scenario, targets, encodes, attempts, buffers, reserve
vars == <<live, blocked, queue, logicalBytes, wire, admitted, b, phase,
          cursor, scenario, targets, encodes, attempts, buffers, reserve>>
Init == /\ live \in SUBSET Clients
        /\ blocked \in SUBSET Clients
        /\ scenario \in {"all", "none", "one", "dialog"}
        /\ queue = [c \in Clients |-> <<>>]
        /\ logicalBytes = [c \in Clients |-> 0]
        /\ wire = [c \in Clients |-> <<>>]
        /\ admitted = [c \in Clients |-> <<>>]
        /\ b = 0 /\ phase = "idle" /\ cursor = 1
        /\ targets = [f \in Frames |-> {}]
        /\ encodes = [f \in Frames |-> 0]
        /\ attempts = [f \in Frames |-> 0]
        /\ buffers = [f \in Frames |-> f]
        /\ reserve \in [Clients -> 0..1]
Selected == CASE scenario = "none" -> {}
                 [] scenario = "one" -> {2}
                 [] scenario = "dialog" -> {1}
                 [] OTHER -> Clients
Begin == /\ phase = "idle" /\ b < 2
         /\ b' = b + 1 /\ phase' = "broadcast" /\ cursor' = 1
         /\ targets' = [targets EXCEPT ![b + 1] = Selected]
         /\ encodes' = (IF Fault = "eager" THEN [encodes EXCEPT ![b + 1] = 1] ELSE encodes)
         /\ UNCHANGED <<live, blocked, queue, logicalBytes, wire, admitted,
                         scenario, attempts, buffers>>
         /\ UNCHANGED reserve
Eligible == cursor \in live /\ cursor \in targets[b]
Retarget == Fault = "retarget" /\ scenario = "dialog" /\ 1 \notin live /\ cursor = 2 /\ 2 \in live
Visit == /\ phase = "broadcast" /\ cursor \in Clients
         /\ cursor' = cursor + 1
         /\ IF Eligible \/ Retarget
               THEN /\ attempts' = [attempts EXCEPT ![b] = @ + 1]
                    /\ encodes' = [encodes EXCEPT ![b] = 1]
                    /\ buffers' = (IF Fault = "mutable" /\ b = 2
                                    THEN [buffers EXCEPT ![1] = 2] ELSE buffers)
                    /\ IF logicalBytes[cursor] + reserve[cursor] + Size(b) > Limit
                          THEN /\ live' = live \ {cursor}
                               /\ queue' = [queue EXCEPT ![cursor] = <<>>]
                               /\ logicalBytes' = [logicalBytes EXCEPT ![cursor] = 0]
                               /\ UNCHANGED admitted
                          ELSE /\ queue' = [queue EXCEPT ![cursor] = Append(@, b)]
                               /\ logicalBytes' = (IF Fault = "accounting" /\ cursor = 2 THEN logicalBytes
                                                    ELSE [logicalBytes EXCEPT ![cursor] = @ + Size(b)])
                               /\ admitted' = [admitted EXCEPT ![cursor] = Append(@, b)]
                               /\ UNCHANGED live
               ELSE UNCHANGED <<live, queue, logicalBytes, admitted, attempts, encodes, buffers>>
         /\ UNCHANGED <<blocked, wire, b, phase, scenario, targets>>
         /\ UNCHANGED reserve
Complete == /\ phase = "broadcast" /\ cursor = 3
            /\ phase' = "idle"
            /\ UNCHANGED <<live, blocked, queue, logicalBytes, wire, admitted,
                            b, cursor, scenario, targets, encodes, attempts, buffers, reserve>>
Write(c, stop) == /\ c \in live /\ c \notin blocked /\ Len(queue[c]) > 0
                 /\ LET index == IF Fault = "order" THEN Len(queue[c]) ELSE 1
                        f == queue[c][index]
                    IN /\ queue' = [queue EXCEPT ![c] = IF index = 1 THEN Tail(@) ELSE SubSeq(@, 1, Len(@) - 1)]
                       /\ logicalBytes' = [logicalBytes EXCEPT ![c] = @ - Size(f)]
                       /\ wire' = [wire EXCEPT ![c] = Append(@, buffers[f])]
                 /\ blocked' = (IF stop THEN blocked \cup {c} ELSE blocked)
                 /\ UNCHANGED <<live, admitted, b, phase, cursor, scenario, targets, encodes, attempts, buffers, reserve>>
Drain(c) == /\ c \in live /\ c \in blocked
            /\ blocked' = blocked \ {c}
            /\ UNCHANGED <<live, queue, logicalBytes, wire, admitted, b, phase,
                            cursor, scenario, targets, encodes, attempts, buffers, reserve>>
Fail(c) == /\ c \in live
           /\ live' = live \ {c}
           /\ queue' = (IF Fault = "coupled" THEN [d \in Clients |-> <<>>] ELSE [queue EXCEPT ![c] = <<>>])
           /\ logicalBytes' = (IF Fault = "coupled" THEN [d \in Clients |-> 0] ELSE [logicalBytes EXCEPT ![c] = 0])
           /\ UNCHANGED <<blocked, wire, admitted, b, phase, cursor, scenario, targets, encodes, attempts, buffers, reserve>>
Next == Begin \/ Visit \/ Complete \/ (\E c \in Clients: Drain(c) \/ Fail(c) \/ (\E stop \in BOOLEAN: Write(c, stop)))
TypeOK == /\ reserve \in [Clients -> 0..1]
          /\ buffers \in [Frames -> Frames]
          /\ encodes \in [Frames -> 0..1] /\ attempts \in [Frames -> 0..2]
          /\ targets \in [Frames -> SUBSET Clients]
          /\ live \subseteq Clients /\ blocked \subseteq Clients
          /\ queue \in [Clients -> Seq(Frames)] /\ wire \in [Clients -> Seq(Frames)]
          /\ admitted \in [Clients -> Seq(Frames)]
          /\ logicalBytes \in [Clients -> 0..Limit]
          /\ b \in 0..2 /\ cursor \in 1..3 /\ phase \in {"idle", "broadcast"}
EncodeOnceOnDemand == \A f \in Frames: encodes[f] = (IF attempts[f] > 0 THEN 1 ELSE 0)
ImmutableBytes == \A f \in Frames: encodes[f] = 1 => buffers[f] = f
Bounded == \A c \in live: logicalBytes[c] + reserve[c] <= Limit
QueueAccounting == \A c \in Clients: logicalBytes[c] = QBytes(queue[c])
RecipientOrder == \A c \in Clients: wire[c] = SubSeq(admitted[c], 1, Len(wire[c]))
LocalIsolation == \A c \in live: admitted[c] = wire[c] \o queue[c]
Routing == \A c \in Clients: \A i \in 1..Len(admitted[c]): c \in targets[admitted[c][i]]
Spec == Init /\ [][Next]_vars
=====================================================================
