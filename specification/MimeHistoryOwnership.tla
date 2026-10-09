------------------------ MODULE MimeHistoryOwnership ------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Owners, Collide, Share, Validate, TrackAll, Release
VARIABLES used, live, bundles, index, digests, preserved, shared, registered
vars == <<used, live, bundles, index, digests, preserved, shared, registered>>
Values == {"str-A", "str-B", "bytes-A"}
Missing == "missing"
Fingerprint(v) == IF Collide THEN 0 ELSE
                  IF v = "str-A" THEN 0 ELSE IF v = "str-B" THEN 1 ELSE
                  IF v = "bytes-A" THEN 2 ELSE 3
(* Collide deliberately puts all typed contents in one abstract digest bucket;
   a second configuration checks distinct digests. Full equality is required.
   Each owner models one public bundle slot. The implementation scans current
   slots without retaining MIME keys. Only live, correctly indexed candidates
   must be reused: arbitrary mutation to a different digest is not discovery.
   It is neither intercepted nor followed by a whole-history reindex.
   Payload identity is separate from content; mutation keeps the record alive.
   Pool operations and callbacks are atomic (a reentrant implementation lock).
   Owners are monotonic tokens, never addresses or weakref equality keys. *)
Init == /\ used = {} /\ live = {} /\ index = {}
        /\ digests = [o \in Owners |-> 0]
        /\ bundles = [o \in Owners |-> [value |-> Missing, object |-> <<o, "fresh">>]]
        /\ preserved = TRUE /\ shared = TRUE /\ registered = TRUE
Matches(v, owners) == {o \in owners : bundles[o].value = v}
Publish(o, v) ==
    LET bucket == {i \in index \cap live : digests[i] = Fingerprint(v)}
        available == Matches(v, bucket)
        candidates == IF Validate THEN available
                      ELSE {i \in bucket : bundles[i].value # Missing}
        picked == IF ~Share \/ candidates = {} THEN o
                  ELSE CHOOSE i \in candidates : TRUE
        value == IF picked = o THEN v ELSE bundles[picked].value
        object == IF picked = o THEN <<o, "fresh">> ELSE bundles[picked].object
        register == TrackAll \/ candidates = {}
    IN /\ o \notin used
       /\ used' = used \cup {o} /\ live' = live \cup {o}
       /\ bundles' = [bundles EXCEPT ![o] = [value |-> value, object |-> object]]
       /\ digests' = [digests EXCEPT ![o] = Fingerprint(v)]
       /\ index' = IF register THEN index \cup {o} ELSE index
       /\ registered' = (registered /\ register)
       /\ preserved' = (preserved /\ value = v)
       /\ shared' = (shared /\ (available = {} \/
                             \E i \in available : object = bundles[i].object))
Mutate(o, v) == /\ o \in live
                /\ bundles' = [bundles EXCEPT ![o] = [value |-> v, object |-> <<o, v>>]]
                /\ UNCHANGED <<used, live, index, digests, preserved, shared, registered>>
Prune(o) == /\ o \in index
            /\ (bundles[o].value = Missing \/ Fingerprint(bundles[o].value) # digests[o])
            /\ index' = index \ {o}
            /\ UNCHANGED <<used, live, bundles, digests, preserved, shared, registered>>
Collect(o) == /\ o \in live /\ live' = live \ {o}
              /\ index' = IF Release THEN index \ {o} ELSE index
              /\ UNCHANGED <<used, bundles, digests, preserved, shared, registered>>
Clear == /\ live # {} /\ live' = {}
         /\ index' = IF Release THEN {} ELSE index
         /\ UNCHANGED <<used, bundles, digests, preserved, shared, registered>>
Next == (\E o \in Owners, v \in Values : Publish(o, v))
        \/ (\E o \in Owners, v \in Values \cup {Missing} : Mutate(o, v))
        \/ (\E o \in Owners : Collect(o) \/ Prune(o)) \/ Clear
Spec == Init /\ [][Next]_vars
TypeOK == /\ live \subseteq used /\ used \subseteq Owners
          /\ index \subseteq used /\ preserved \in BOOLEAN /\ shared \in BOOLEAN
ContentPreserved == preserved
IndexedPayloadReused == shared
EveryNewOwnerIndexed == registered
WeakMetadataOnly == index \subseteq live
=============================================================================
