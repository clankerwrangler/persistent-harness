------------------------ MODULE MessageLocation ------------------------
\* Sources:
\*   src/store.mjs sha256:82e659225f74f2e93f3b87d4b8fe1d02a50aa8d75c6a90ee51f9b32860e349e6
\*   src/actor-coordinator.mjs sha256:d33d75f88913edccec70c1cc2df0391a3e909d958f96acfd890c3b774935ae62
\*   src/supervisor.mjs sha256:280ac4bdfaca53e29b061ad9d9c74569546e3b8dc0406860b1727e26089df37f
\*   src/visible-transcript-reader.mjs sha256:244b202937ba51f1c9f06e272fe77ba34cd3316d43cbed956bf6ee98b7fc8061
\*   src/input-location.mjs sha256:a6267b63c81f85e71d0483c166e0a6480d5d37dfba5929ee9eb203eec2428781
\*   src/conversation-projection.mjs sha256:9ccd97f1657710f009ea425590b99a791e5c7ba4b1a9367e96d9da67787cabed
EXTENDS Naturals, Sequences, FiniteSets
\* The caller supplies an already-frozen optional attachment. Browser consent,
\* acquisition deadlines, and cancellation are not harness guarantees.
CONSTANT None
VARIABLES frozen, dispatched, durable, canonical, retries
vars == <<frozen, dispatched, durable, canonical, retries>>
Range(seq) == {seq[i] : i \in 1..Len(seq)}
Locations == {"A", "B"}
Records == [text : {"genuine text"}, location : Locations \cup {None}]
Init == /\ frozen \in Records /\ dispatched = <<frozen>>
        /\ durable = <<>> /\ canonical = <<>> /\ retries = <<>>
Admit == /\ Len(dispatched) = 1 /\ Len(durable) = 0 /\ Len(canonical) = 0
         /\ durable' = dispatched
         /\ UNCHANGED <<frozen, dispatched, canonical, retries>>
Replay == /\ Len(dispatched) = 1 /\ UNCHANGED vars
Commit == /\ Len(durable) = 1 /\ Len(canonical) = 0
          /\ canonical' = durable /\ durable' = <<>>
          /\ UNCHANGED <<frozen, dispatched, retries>>
RetryOriginal == /\ Len(canonical) = 1 /\ Len(retries) = 0 /\ retries' = canonical
                 /\ UNCHANGED <<frozen, dispatched, durable, canonical>>
Next == Admit \/ Replay \/ Commit \/ RetryOriginal
TypeOK == /\ frozen \in Records
          /\ \A records \in {dispatched, durable, canonical, retries}:
               records \in Seq(Records) /\ Len(records) <= 1
ExactMessage == \A record \in {frozen} \cup Range(dispatched) \cup Range(durable)
                                \cup Range(canonical) \cup Range(retries): record.text = "genuine text"
\* Equality covers the complete payload, including the optional location.
Immutable == /\ dispatched = <<frozen>>
             /\ (Len(durable) = 1 => durable = dispatched)
             /\ (Len(canonical) = 1 => canonical = dispatched)
             /\ (Len(retries) = 1 => retries = canonical)
\* These views abstract information availability, not exact wire text. The
\* provider renderer adds a model-only disclosure; public projection omits it.
Provider(record) == [role |-> "user", text |-> record.text, location |-> record.location]
Public(record) == [role |-> "user", text |-> record.text]
ProjectionBoundary == \A record \in Range(canonical):
                         /\ Provider(record).role = "user"
                         /\ Provider(record).text = Public(record).text
                         /\ Provider(record).location = record.location
                         /\ ~("location" \in DOMAIN Public(record))
Spec == Init /\ [][Next]_vars
=============================================================================
