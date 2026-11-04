------------------------- MODULE WorkerResultWire -------------------------
\* Sources:
\*   src/sdk-worker.mjs sha256:ad3637bdce0be9028c01b99eb3b0c619d76473b0def01bae88de50127622ea0a
\*   src/actor-coordinator.mjs sha256:d33d75f88913edccec70c1cc2df0391a3e909d958f96acfd890c3b774935ae62
\*   src/supervisor.mjs sha256:280ac4bdfaca53e29b061ad9d9c74569546e3b8dc0406860b1727e26089df37f
EXTENDS Naturals, Sequences
CONSTANT Fault
VARIABLES mode, root, image, outcome, step, canonical, hooks, wire, visible, expected
vars == <<mode, root, image, outcome, step, canonical, hooks, wire, visible, expected>>
\* Wire compaction follows in-process observers and the canonical append. A late
\* cancelled tool can still commit; cancellation does not fabricate turn_end.
Kinds == <<"user", "assistant", "toolStart", "toolUpdate", "toolEnd",
           "resultStart", "resultEnd", "turnEnd", "agentEnd", "settled">>
Payload(k) == IF k \in {"toolStart", "toolUpdate", "toolEnd", "resultStart", "resultEnd", "turnEnd", "agentEnd"} THEN "full" ELSE "none"
Raw(k) == [kind |-> k, body |-> Payload(k),
           image |-> (image /\ k = "resultEnd"), identity |-> "original",
           text |-> "original", error |-> outcome, usage |-> "original"]
Compact(e) == [e EXCEPT !.body = "none",
              !.image = IF Fault = "dropImage" THEN FALSE ELSE @]
Transport(e) == IF (mode = "supervised-source" /\ Fault # "leak") \/ Fault = "compactFull"
                THEN Compact(e) ELSE e
\* Existing supervisor ownership ignores tool bodies, turn/agent summaries,
\* and result metadata. Root image presence invalidates canonical image rows.
Project(e) == [kind |-> e.kind, identity |-> e.identity, text |-> e.text,
               error |-> e.error, usage |-> e.usage,
               refresh |-> (root /\ e.kind = "resultEnd" /\ e.image)]
Init == /\ mode \in {"full", "supervised-source"} /\ root \in BOOLEAN
        /\ image \in BOOLEAN /\ outcome \in {"stop", "error", "cancel"}
        /\ step = 1 /\ canonical = "absent" /\ hooks = <<>>
        /\ wire = <<>> /\ visible = <<>> /\ expected = <<>>
Send == /\ step <= Len(Kinds)
        /\ LET k == Kinds[step]
               raw == Raw(k)
               frame == Transport(raw)
               skipped == (outcome = "cancel" /\ k = "turnEnd")
           IN /\ wire' = IF skipped THEN wire ELSE Append(wire, frame)
              /\ hooks' = IF skipped THEN hooks ELSE Append(hooks, raw)
              /\ visible' = IF skipped THEN visible ELSE Append(visible, Project(frame))
              /\ expected' = IF skipped THEN expected ELSE Append(expected, Project(raw))
              /\ canonical' = IF k = "resultEnd" THEN
                                (IF Fault = "mutateCanonical" THEN frame.body ELSE raw.body)
                              ELSE canonical
        /\ step' = step + 1
        /\ UNCHANGED <<mode, root, image, outcome>>
CanonicalPreserved == step > 7 => canonical = "full"
ObserversPreserved == \A i \in 1..Len(hooks): hooks[i] = Raw(hooks[i].kind)
DirectPreserved == mode = "full" => wire = hooks
SupervisorEquivalent == visible = expected
NoSupervisedBodies == mode = "supervised-source" => \A i \in 1..Len(wire): wire[i].body = "none"
Spec == Init /\ [][Send]_vars
=============================================================================
