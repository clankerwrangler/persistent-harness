--------------------- MODULE FailedCallProjection ---------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
\* Two provider call identities abstract the completed native prefix and the
\* interrupted suffix. Original records, results, and signatures never change.
\* Evidence is usable only for a failed turn, a fenced/retired exact attempt,
\* an explicitly incomplete nonnative observation, and no contrary admission.
CONSTANT Calls
VARIABLES admitted, results, failed, incomplete, conflicting, fenced,
          selected, kept, mode, phase, canonical, projected, skipped, blocking,
          outstanding, effects
vars == <<admitted, results, failed, incomplete, conflicting, fenced,
          selected, kept, mode, phase, canonical, projected, skipped, blocking,
          outstanding, effects>>
Unadmitted == IF fenced THEN
  (selected \cap failed \cap incomplete) \ (admitted \cup results \cup conflicting)
  ELSE {}
Init == /\ admitted \in SUBSET Calls
        /\ results \in SUBSET Calls
        /\ failed \in SUBSET Calls
        /\ incomplete \in SUBSET Calls
        /\ conflicting \in SUBSET Calls
        /\ fenced \in BOOLEAN
        /\ selected \in {Calls, {"prefix"}, {"suffix"}}
        /\ kept \in {Calls, {"suffix"}, {}}
        /\ mode \in {"native", "ordinary"}
        /\ canonical = <<selected, admitted, results, failed, incomplete, conflicting>>
        /\ phase = "input" /\ projected = {} /\ skipped = {}
        /\ outstanding = {} /\ blocking = {} /\ effects = {}
Project == /\ phase = "input"
           /\ skipped' = kept \cap Unadmitted
           /\ projected' = (selected \cap kept) \ Unadmitted
           /\ outstanding' = (selected \cap admitted) \ results
           /\ blocking' = IF mode = "native" THEN {} ELSE
                ((selected \cap kept) \ Unadmitted) \cap (failed \cup (Calls \ results))
           /\ phase' = "projected"
           /\ UNCHANGED <<admitted, results, failed, incomplete, conflicting,
                 fenced, selected, kept, mode, canonical, effects>>
Next == Project \/ (phase = "projected" /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
CanonicalPreserved == canonical = <<selected, admitted, results, failed, incomplete, conflicting>>
NoExecution == effects = {}
PositiveEvidenceOnly == skipped \subseteq failed \cap incomplete
AdmissionPreserved == phase = "projected" =>
  selected \cap kept \cap (admitted \cup results \cup conflicting) \subseteq projected
NoInvention == projected \subseteq selected \cap kept
NoUnadmittedReplay == phase = "projected" => projected \cap Unadmitted = {}
OtherMessagesPreserved == phase = "projected" => projected \cup skipped = selected \cap kept
UnknownStillOutstanding == phase = "projected" => outstanding = (selected \cap admitted) \ results
NoCompactionBypass == phase = "projected" /\ mode = "ordinary" =>
  \A c \in projected : (c \in failed \/ c \notin results) => c \in blocking
BranchScoped == skipped \subseteq selected
=============================================================================
