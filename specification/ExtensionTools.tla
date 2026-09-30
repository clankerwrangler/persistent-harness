-------------------------- MODULE ExtensionTools --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Cells, Tools, Callable, Granted, RecordLimit
VARIABLES active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete
vars == <<active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete>>
Init == /\ active = 0 /\ cancelled = {} /\ phase = "idle" /\ owner = 0 /\ target \in Tools
        /\ admitted = {} /\ effects = {} /\ replies = {} /\ records = {} /\ canonical = {} /\ complete = TRUE
Start(c) == /\ active = 0 /\ c \in Cells /\ c \notin canonical
            /\ active' = c /\ UNCHANGED <<cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete>>
Request(t) == /\ active # 0 /\ phase = "idle" /\ active \notin cancelled
              /\ phase' = "requested" /\ owner' = active /\ target' = t
              /\ UNCHANGED <<active, cancelled, admitted, effects, replies, records, canonical, complete>>
Admit == /\ phase = "requested" /\ owner = active /\ owner \notin cancelled /\ target \in (Callable \cap Granted)
         /\ phase' = "running" /\ admitted' = admitted \cup {<<owner,target>>}
         /\ UNCHANGED <<active, cancelled, owner, target, effects, replies, records, canonical, complete>>
Deny == /\ phase = "requested" /\ (owner # active \/ owner \in cancelled \/ target \notin (Callable \cap Granted))
        /\ phase' = "finished" /\ UNCHANGED <<active, cancelled, owner, target, admitted, effects, replies, records, canonical, complete>>
Execute == /\ phase = "running" /\ owner \notin cancelled
           /\ effects' = effects \cup {<<owner,target>>} /\ phase' = "finished"
           /\ UNCHANGED <<active, cancelled, owner, target, admitted, replies, records, canonical, complete>>
Cancel == /\ active # 0 /\ cancelled' = cancelled \cup {active}
          /\ UNCHANGED <<active, phase, owner, target, admitted, effects, replies, records, canonical, complete>>
CancelledOutcome == /\ phase = "running" /\ owner \in cancelled /\ phase' = "finished"
                    /\ UNCHANGED <<active, cancelled, owner, target, admitted, effects, replies, records, canonical, complete>>
EndCell == /\ active # 0 /\ (phase \in {"idle","finished"} \/ active \in cancelled)
           /\ canonical' = canonical \cup {active} /\ active' = 0
           /\ UNCHANGED <<cancelled, phase, owner, target, admitted, effects, replies, records, complete>>
Reply == /\ phase = "finished" /\ phase' = "idle"
         /\ replies' = IF active = owner /\ owner \notin cancelled THEN replies \cup {<<owner,active>>} ELSE replies
         /\ records' = IF Cardinality(records) < RecordLimit THEN records \cup {<<owner,target>>} ELSE records
         /\ complete' = complete /\ Cardinality(records) < RecordLimit
         /\ UNCHANGED <<active, cancelled, owner, target, admitted, effects, canonical>>
Next == (\E c \in Cells : Start(c)) \/ (\E t \in Tools : Request(t)) \/ Admit \/ Deny \/ Execute \/ Cancel \/ CancelledOutcome \/ EndCell \/ Reply
Spec == Init /\ [][Next]_vars
Policy == \A p \in effects : p[2] \in (Callable \cap Granted) /\ p \in admitted
CellIdentity == \A p \in replies : p[1] = p[2]
ParentOnly == canonical \subseteq Cells
BoundedRecords == Cardinality(records) <= RecordLimit
=============================================================================
