------------------------- MODULE WorkerResultWire -------------------------
EXTENDS Naturals, Sequences
CONSTANT Fault
VARIABLES mode, root, image, outcome, step, canonical, hooks, wire, visible, expected
vars == <<mode, root, image, outcome, step, canonical, hooks, wire, visible, expected>>
\* Wire compaction follows in-process observers and the canonical append. A late
\* cancelled tool can still commit; cancellation does not fabricate turn_end.
Kinds == <<"user", "assistant", "toolStart", "toolUpdate", "toolEnd",
           "resultStart", "resultEnd", "turnEnd", "agentEnd", "settled">>
Payload(k) == IF k \in {"toolEnd", "resultStart", "resultEnd", "turnEnd", "agentEnd"} THEN "full" ELSE "none"
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
