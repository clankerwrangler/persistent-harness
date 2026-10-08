------------------------- MODULE SessionHistory -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Callers, CheckPrefix, CheckStable, RespectAbort, Drain, MaxVersion
VARIABLES source, prefix, pending, branch, cache, rows, phase, owner, selected,
          staged, cancelled, daemon, returned, mixed, lateAccess
vars == <<source, prefix, pending, branch, cache, rows, phase, owner, selected,
          staged, cancelled, daemon, returned, mixed, lateAccess>>
\* source is the accepted dependency version: canonical inventory AND receipt digests.
\* prefix/pending/branch are provenance tags, not equality of the underlying bytes.
\* Change includes receipt-only change: unchanged bytes cannot validate old rendering.
Version(v) == [version |-> v, prefix |-> v, pending |-> v, branch |-> v]
Empty == Version(0)
Init == /\ source = 1 /\ prefix = 1 /\ pending = 1 /\ branch = 1
        /\ cache = Empty /\ rows = Empty /\ owner = "none"
        /\ phase = [c \in Callers |-> "idle"] /\ selected = [c \in Callers |-> 0]
        /\ staged = [c \in Callers |-> Empty] /\ cancelled = {}
        /\ daemon = "running" /\ returned = {} /\ mixed = FALSE /\ lateAccess = FALSE
Submit(c) == /\ daemon = "running" /\ phase[c] = "idle"
             /\ phase' = [phase EXCEPT ![c] = "queued"]
             /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, owner, selected,
                             staged, cancelled, daemon, returned, mixed, lateAccess>>
Acquire(c) == /\ phase[c] = "queued" /\ owner = "none" /\ c \notin cancelled
              /\ owner' = c /\ phase' = [phase EXCEPT ![c] = "read"]
              /\ selected' = [selected EXCEPT ![c] = source]
              /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, staged,
                              cancelled, daemon, returned, mixed, lateAccess>>
Change == /\ source < MaxVersion /\ source' = source + 1
          /\ prefix' = source + 1 /\ pending' = source + 1 /\ branch' = source + 1
          /\ UNCHANGED <<cache, rows, phase, owner, selected, staged, cancelled, daemon, returned, mixed, lateAccess>>
Verify(c) == /\ owner = c /\ phase[c] = "read" /\ (~RespectAbort \/ c \notin cancelled)
             /\ (~CheckStable \/ selected[c] = source)
             /\ staged' = [staged EXCEPT ![c] = IF CheckPrefix \/ cache = Empty
                  THEN Version(selected[c]) ELSE [Version(selected[c]) EXCEPT !.prefix = cache.prefix]]
             /\ phase' = [phase EXCEPT ![c] = "verified"]
             /\ lateAccess' = (lateAccess \/ daemon = "closed")
             /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, owner, selected,
                             cancelled, daemon, returned, mixed>>
Publish(c) == /\ owner = c /\ phase[c] = "verified" /\ (~RespectAbort \/ c \notin cancelled)
              /\ (~CheckStable \/ selected[c] = source)
              /\ cache' = staged[c] /\ rows' = staged[c]
              /\ phase' = [phase EXCEPT ![c] = "hydrate"]
              /\ mixed' = (mixed \/ selected[c] # source \/ c \in cancelled)
              /\ lateAccess' = (lateAccess \/ daemon = "closed")
              /\ UNCHANGED <<source, prefix, pending, branch, owner, selected, staged, cancelled, daemon, returned>>
Hydrate(c) == /\ owner = c /\ phase[c] = "hydrate" /\ (~RespectAbort \/ c \notin cancelled)
              /\ (~CheckStable \/ rows.version = source)
              /\ returned' = returned \cup {<<rows.version, selected[c], source>>}
              /\ phase' = [phase EXCEPT ![c] = "done"] /\ owner' = "none"
              /\ mixed' = (mixed \/ c \in cancelled)
              /\ lateAccess' = (lateAccess \/ daemon = "closed")
              /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, selected, staged, cancelled, daemon>>
Cancel(c) == /\ phase[c] \in {"queued", "read", "verified", "hydrate"} /\ c \notin cancelled
             /\ cancelled' = cancelled \cup {c}
             /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, phase, owner, selected, staged, daemon, returned, mixed, lateAccess>>
Settle(c) == /\ phase[c] \in {"queued", "read", "verified", "hydrate"}
             /\ (c \in cancelled \/ (owner = c /\ selected[c] # source))
             /\ phase' = [phase EXCEPT ![c] = "failed"] /\ owner' = IF owner = c THEN "none" ELSE owner
             /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, selected, staged, cancelled, daemon, returned, mixed, lateAccess>>
Stop == /\ daemon = "running" /\ daemon' = "stopping"
        /\ cancelled' = cancelled \cup {c \in Callers: phase[c] \in {"queued", "read", "verified", "hydrate"}}
        /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, phase, owner, selected, staged, returned, mixed, lateAccess>>
Close == /\ daemon = "stopping" /\ (~Drain \/ (owner = "none" /\ \A c \in Callers: phase[c] \notin {"queued", "read", "verified", "hydrate"}))
         /\ daemon' = "closed"
         /\ UNCHANGED <<source, prefix, pending, branch, cache, rows, phase, owner, selected, staged, cancelled, returned, mixed, lateAccess>>
Next == Change \/ Stop \/ Close \/ (\E c \in Callers: Submit(c) \/ Acquire(c) \/ Verify(c) \/ Publish(c) \/ Hydrate(c) \/ Cancel(c) \/ Settle(c))
AtomicVersion == cache = Version(cache.version) /\ rows = Version(rows.version)
VerifiedResults == ~mixed /\ \A r \in returned: r[1] = r[2] /\ r[2] = r[3]
CloseAfterDrain == daemon = "closed" => owner = "none" /\ \A c \in Callers: phase[c] \notin {"queued", "read", "verified", "hydrate"}
NoClosedAccess == ~lateAccess
IndependentCancellation == \A c \in Callers: phase[c] = "queued" /\ c \notin cancelled /\ owner = "none" => ENABLED Acquire(c)
Spec == Init /\ [][Next]_vars
=============================================================================
