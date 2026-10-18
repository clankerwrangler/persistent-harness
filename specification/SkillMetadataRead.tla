-------------------------- MODULE SkillMetadataRead --------------------------
EXTENDS Naturals, Sequences, TLC

CONSTANT Fault
ASSUME Fault \in {"none", "decoded", "link", "basename", "stale"}

MD == "SKILL.md"
PY == "pyproject.toml"
Nested == "nested/SKILL.md"
Source == "src/demo.py"
Metadata == {MD, PY}
Paths == Metadata \cup {Nested, Source}
Empty == [bytes |-> <<>>, owner |-> 0]

VARIABLES kinds, version, load, phase, cursor, buffers, parsed, reads, stream
vars == <<kinds, version, load, phase, cursor, buffers, parsed, reads, stream>>

Raw(p, v) ==
  CASE p = MD -> IF v = 0 THEN <<65, 255>> ELSE <<65, 254>>
    [] p = PY -> <<80, v>>
    [] p = Nested -> <<78, v>>
    [] p = Source -> <<83, v>>

\* Both invalid UTF-8 byte sequences decode to the same replacement character.
Decode(b) == IF b \in {<<65, 255>>, <<65, 254>>}
             THEN <<65, 239, 191, 189>> ELSE b
Link(p, v) == IF p = MD THEN <<116, 109, v>> ELSE <<116, 112, v>>
Kind(p) == IF p \in Metadata THEN kinds[p] ELSE "file"
Walk == IF kinds[PY] = "absent" THEN <<Nested, MD, Source>>
        ELSE <<Nested, PY, MD, Source>>
Expected(p) == [path |-> p, kind |-> Kind(p),
                payload |-> IF Kind(p) = "link" THEN Link(p, version)
                           ELSE Raw(p, version)]
ExpectedStream == [i \in 1..Len(Walk) |-> Expected(Walk[i])]

Init ==
  /\ kinds \in [Metadata -> {"file", "link", "absent"}]
  /\ kinds[MD] # "absent"
  /\ version = 0
  /\ load = 1
  /\ phase = "read"
  /\ cursor = 1
  /\ buffers = [p \in Metadata |-> Empty]
  /\ parsed = [p \in Metadata |-> <<>>]
  /\ reads = [p \in Paths |-> 0]
  /\ stream = <<>>

ReadMetadata ==
  /\ phase = "read"
  /\ cursor <= 2
  /\ LET p == <<MD, PY>>[cursor]
         present == kinds[p] # "absent"
         reuse == Fault = "stale" /\ buffers[p].owner > 0
         value == IF reuse THEN buffers[p].bytes ELSE Raw(p, version)
     IN /\ buffers' = IF present /\ ~reuse
                      THEN [buffers EXCEPT ![p] = [bytes |-> value, owner |-> load]]
                      ELSE buffers
        /\ parsed' = IF present THEN [parsed EXCEPT ![p] = Decode(value)] ELSE parsed
        /\ reads' = IF present /\ ~reuse THEN [reads EXCEPT ![p] = @ + 1] ELSE reads
  /\ cursor' = cursor + 1
  /\ UNCHANGED <<kinds, version, load, phase, stream>>

StartWalk ==
  /\ phase = "read" /\ cursor = 3
  /\ phase' = "walk" /\ cursor' = 1
  /\ UNCHANGED <<kinds, version, load, buffers, parsed, reads, stream>>

WalkEntry ==
  /\ phase = "walk"
  /\ cursor <= Len(Walk)
  /\ LET p == Walk[cursor]
         key == IF Fault = "basename" /\ p = Nested THEN MD ELSE p
         buffered == key \in Metadata
         useBytes == buffered /\ (Kind(p) = "file" \/ Fault = "link")
         payload == IF Kind(p) = "link" /\ ~useBytes THEN Link(p, version)
                    ELSE IF useBytes THEN
                      IF Fault = "decoded" THEN Decode(buffers[key].bytes)
                      ELSE buffers[key].bytes
                    ELSE Raw(p, version)
     IN /\ stream' = Append(stream, [path |-> p, kind |-> Kind(p), payload |-> payload])
        /\ reads' = IF Kind(p) = "file" /\ ~useBytes
                    THEN [reads EXCEPT ![p] = @ + 1] ELSE reads
  /\ cursor' = cursor + 1
  /\ UNCHANGED <<kinds, version, load, phase, buffers, parsed>>

FinishWalk ==
  /\ phase = "walk" /\ cursor = Len(Walk) + 1
  /\ phase' = "complete"
  /\ UNCHANGED <<kinds, version, load, cursor, buffers, parsed, reads, stream>>

NextLoad ==
  /\ phase = "complete" /\ load = 1
  /\ version' = 1 /\ load' = 2 /\ phase' = "read" /\ cursor' = 1
  /\ buffers' = IF Fault = "stale" THEN buffers ELSE [p \in Metadata |-> Empty]
  /\ parsed' = [p \in Metadata |-> <<>>]
  /\ reads' = [p \in Paths |-> 0]
  /\ stream' = <<>>
  /\ UNCHANGED kinds

Done ==
  /\ phase = "complete" /\ load = 2
  /\ phase' = "done"
  /\ UNCHANGED <<kinds, version, load, cursor, buffers, parsed, reads, stream>>

Next == ReadMetadata \/ StartWalk \/ WalkEntry \/ FinishWalk \/ NextLoad \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ kinds \in [Metadata -> {"file", "link", "absent"}]
  /\ kinds[MD] # "absent"
  /\ version \in 0..1 /\ load \in 1..2
  /\ phase \in {"read", "walk", "complete", "done"}
  /\ cursor \in 1..5
  /\ DOMAIN buffers = Metadata /\ DOMAIN parsed = Metadata
  /\ reads \in [Paths -> 0..1]

FreshLoad == phase \in {"walk", "complete", "done"} =>
  \A p \in Metadata : kinds[p] # "absent" =>
    /\ buffers[p].owner = load
    /\ buffers[p].bytes = Raw(p, version)
    /\ parsed[p] = Decode(Raw(p, version))

RawFeedParity == phase \in {"complete", "done"} => stream = ExpectedStream

OneMetadataRead == phase \in {"complete", "done"} =>
  \A p \in Metadata : reads[p] = IF kinds[p] = "absent" THEN 0 ELSE 1

UncachedSourceRead == phase \in {"complete", "done"} =>
  reads[Nested] = 1 /\ reads[Source] = 1
=============================================================================
