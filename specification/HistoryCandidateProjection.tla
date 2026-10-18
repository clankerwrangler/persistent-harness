---------------------- MODULE HistoryCandidateProjection ----------------------
EXTENDS Naturals
CONSTANTS ResolveHistoryFast, ResolveDefaultFast, PreserveMetadata, PreserveErrors
VARIABLES version, consumer, malformed, phase, sampled, metadata, fast, fastReads
vars == <<version, consumer, malformed, phase, sampled, metadata, fast, fastReads>>
Metadata(v) == [sessionId |-> "child", kind |-> "child", depth |-> 1,
                name |-> <<"child", v>>, lineage |-> <<"parent", "child", v>>,
                lifecycle |-> "retained", sessionFile |-> "canonical",
                shortId |-> "short", createdAt |-> 0, updatedAt |-> v]
Init == /\ version = 0 /\ consumer \in {"history", "default"}
        /\ malformed \in BOOLEAN /\ phase = "before" /\ sampled = 0
        /\ metadata = Metadata(0) /\ fast = 2 /\ fastReads = 0
Change == /\ version = 0 /\ version' = 1
          /\ UNCHANGED <<consumer, malformed, phase, sampled, metadata, fast, fastReads>>
\* Only the unused Fast derivation changes. Registry observation and the original
\* full mapper (including its errors) remain at the same synchronous boundary.
Read == /\ phase = "before"
        /\ LET resolve == IF consumer = "history" THEN ResolveHistoryFast ELSE ResolveDefaultFast
           IN /\ sampled' = version
              /\ metadata' = IF PreserveMetadata THEN Metadata(version) ELSE Metadata(0)
              /\ fast' = IF resolve THEN version ELSE 2
              /\ fastReads' = IF resolve THEN 3 ELSE 0
              /\ phase' = IF malformed /\ PreserveErrors THEN "error" ELSE "returned"
        /\ UNCHANGED <<version, consumer, malformed>>
Next == Change \/ Read \/ /\ phase # "before" /\ UNCHANGED vars
SameMetadata == phase = "returned" => metadata = Metadata(sampled)
DefaultStillFull == consumer = "default" /\ phase = "returned" => fast = sampled
NoUnusedHistoryReads == consumer = "history" /\ phase # "before" => fastReads = 0
SameError == malformed /\ phase # "before" => phase = "error"
Spec == Init /\ [][Next]_vars
===============================================================================
