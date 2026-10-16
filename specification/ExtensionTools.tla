-------------------------- MODULE ExtensionTools --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Cells, Tools, Callable, Granted, RecordLimit, BadSourceReload
VARIABLES active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads
vars == <<active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
Init == /\ active = 0 /\ cancelled = {} /\ phase = "idle" /\ owner = 0 /\ target \in Tools
        /\ scopeOpen = FALSE /\ generation = 0 /\ sourceGeneration = 0 /\ sourceReads = {}
        /\ admitted = {} /\ effects = {} /\ replies = {} /\ records = {} /\ canonical = {} /\ complete = TRUE /\ providerRequests = {}
Start(c) == /\ active = 0 /\ ~scopeOpen /\ c \in Cells /\ c \notin canonical
            /\ active' = c /\ scopeOpen' = TRUE /\ sourceGeneration' = generation /\ UNCHANGED <<cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete, providerRequests, generation, sourceReads>>
Request(t) == /\ active # 0 /\ phase = "idle" /\ active \notin cancelled
              /\ phase' = "requested" /\ owner' = active /\ target' = t
              /\ UNCHANGED <<active, cancelled, admitted, effects, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
Admit == /\ phase = "requested" /\ owner = active /\ owner \notin cancelled /\ target \in (Callable \cap Granted)
         /\ phase' = "running" /\ admitted' = admitted \cup {<<owner,target>>}
         /\ UNCHANGED <<active, cancelled, owner, target, effects, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
Deny == /\ phase = "requested" /\ (owner # active \/ owner \in cancelled \/ target \notin (Callable \cap Granted))
        /\ phase' = "finished" /\ UNCHANGED <<active, cancelled, owner, target, admitted, effects, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
Execute == /\ phase = "running" /\ owner \notin cancelled
           /\ effects' = effects \cup {<<owner,target>>} /\ phase' = "finished"
           /\ UNCHANGED <<active, cancelled, owner, target, admitted, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
Cancel == /\ active # 0 /\ cancelled' = cancelled \cup {active}
          /\ UNCHANGED <<active, phase, owner, target, admitted, effects, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
CancelledOutcome == /\ phase = "running" /\ owner \in cancelled /\ phase' = "finished"
                    /\ UNCHANGED <<active, cancelled, owner, target, admitted, effects, replies, records, canonical, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
EndCell == /\ active # 0 /\ (phase \in {"idle","finished"} \/ active \in cancelled)
           /\ canonical' = canonical \cup {active} /\ active' = 0
           /\ UNCHANGED <<cancelled, phase, owner, target, admitted, effects, replies, records, complete, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
Reply == /\ phase = "finished" /\ phase' = "idle"
         /\ replies' = IF active = owner /\ owner \notin cancelled THEN replies \cup {<<owner,active>>} ELSE replies
         /\ records' = IF Cardinality(records) < RecordLimit THEN records \cup {<<owner,target>>} ELSE records
         /\ complete' = complete /\ Cardinality(records) < RecordLimit
         /\ UNCHANGED <<active, cancelled, owner, target, admitted, effects, canonical, providerRequests, scopeOpen, generation, sourceGeneration, sourceReads>>
CloseScope == /\ scopeOpen /\ active = 0 /\ phase = "idle"
  /\ scopeOpen' = FALSE
  /\ UNCHANGED <<active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete,
       providerRequests, generation, sourceGeneration, sourceReads>>
Reload == /\ generation = 0 /\ (BadSourceReload \/ ~scopeOpen)
  /\ generation' = 1
  /\ UNCHANGED <<active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete,
       providerRequests, scopeOpen, sourceGeneration, sourceReads>>
ReadSource == /\ scopeOpen
  /\ sourceReads' = sourceReads \cup {<<sourceGeneration,generation>>}
  /\ UNCHANGED <<active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete,
       providerRequests, scopeOpen, generation, sourceGeneration>>
Next == (\E c \in Cells : Start(c)) \/ (\E t \in Tools : Request(t)) \/ Admit \/ Deny \/ Execute \/ Cancel \/ CancelledOutcome \/ EndCell \/ Reply \/ CloseScope \/ Reload \/ ReadSource
\* Provider readiness is distinct from execution readiness: the admitted parent
\* is incomplete until its real tool result exists. Dispatch must still proceed.
ProviderReady == phase = "idle"
ProviderRequest == /\ active # 0 /\ ProviderReady
                   /\ providerRequests' = providerRequests \cup {<<active,phase>>}
                   /\ UNCHANGED <<active, cancelled, phase, owner, target, admitted, effects, replies, records, canonical, complete, scopeOpen, generation, sourceGeneration, sourceReads>>
Spec == Init /\ [][Next \/ ProviderRequest]_vars
AdmissionAvailable == (phase = "requested" /\ owner = active /\ owner \notin cancelled /\ target \in (Callable \cap Granted)) => ENABLED Admit
ProviderGate == \A p \in providerRequests : p[2] = "idle"
Policy == \A p \in effects : p[2] \in (Callable \cap Granted) /\ p \in admitted
CellIdentity == \A p \in replies : p[1] = p[2]
ParentOnly == canonical \subseteq Cells
BorrowedSourceLifetime == \A read \in sourceReads : read[1] = read[2]
BoundedRecords == Cardinality(records) <= RecordLimit
=============================================================================
