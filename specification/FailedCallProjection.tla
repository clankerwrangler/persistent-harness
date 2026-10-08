--------------------- MODULE FailedCallProjection ---------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
\* Native incomplete observations need a retired/fenced attempt. An ordinary
\* failed terminal from a recognized non-streaming-dispatch producer admits no
\* calls, whether its call arguments are complete or partial. Ambiguous producer
\* history is not in ordinary. Contrary admission/result/alias evidence vetoes
\* both paths. The selected canonical archive is never modified or executed.
\* stock means the typed STOCK Codex after-start websocket failure witness:
\* exact API/provider, eventsEmitted=true, transport auto/websocket. Missing or
\* malformed evidence is ambiguous. Own native envelope/error/provider IDs or
\* native call provenance are native; neither category grants STOCK omission.
CONSTANT Calls
VARIABLES admitted, results, failed, incomplete, ordinary, witnessKind, conflicting, fenced,
          selected, kept, mode, phase, canonical, projected, skipped, blocking,
          outstanding, effects
vars == <<admitted, results, failed, incomplete, ordinary, witnessKind, conflicting, fenced,
          selected, kept, mode, phase, canonical, projected, skipped, blocking,
          outstanding, effects>>
StockEvidence == IF witnessKind = "stock" THEN ordinary ELSE {}
Evidence == StockEvidence \cup (IF fenced THEN incomplete ELSE {})
Unadmitted == (selected \cap failed \cap Evidence) \ (admitted \cup results \cup conflicting)
Init == /\ admitted \in SUBSET Calls
        /\ results \in SUBSET Calls
        /\ failed \in SUBSET Calls
        /\ incomplete \in SUBSET Calls
        /\ ordinary \in SUBSET Calls
        /\ witnessKind \in {"stock", "ambiguous", "native"}
        /\ conflicting \in SUBSET Calls
        /\ fenced \in BOOLEAN
        /\ selected \in {Calls, {"prefix"}, {"suffix"}}
        /\ kept \in {Calls, {"suffix"}, {}}
        /\ mode \in {"native", "ordinary"}
        /\ canonical = <<selected, admitted, results, failed, incomplete, ordinary, witnessKind, conflicting>>
        /\ phase = "input" /\ projected = {} /\ skipped = {}
        /\ outstanding = {} /\ blocking = {} /\ effects = {}
Project == /\ phase = "input"
           /\ skipped' = kept \cap Unadmitted
           /\ projected' = (selected \cap kept) \ Unadmitted
           /\ outstanding' = (selected \cap admitted) \ results
           /\ blocking' = IF mode = "native" THEN {} ELSE
                ((selected \cap kept) \ Unadmitted) \cap (failed \cup (Calls \ results))
           /\ phase' = "projected"
           /\ UNCHANGED <<admitted, results, failed, incomplete, ordinary, witnessKind, conflicting,
                 fenced, selected, kept, mode, canonical, effects>>
Next == Project \/ (phase = "projected" /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
CanonicalPreserved == canonical = <<selected, admitted, results, failed, incomplete, ordinary, witnessKind, conflicting>>
NoExecution == effects = {}
PositiveEvidenceOnly == skipped \subseteq failed \cap Evidence
AdmissionPreserved == phase = "projected" =>
  selected \cap kept \cap (admitted \cup results \cup conflicting) \subseteq projected
NoInvention == projected \subseteq selected \cap kept
NoUnadmittedReplay == phase = "projected" => projected \cap Unadmitted = {}
OtherMessagesPreserved == phase = "projected" => projected \cup skipped = selected \cap kept
UnknownStillOutstanding == phase = "projected" => outstanding = (selected \cap admitted) \ results
NoCompactionBypass == phase = "projected" /\ mode = "ordinary" =>
  \A c \in projected : (c \in failed \/ c \notin results) => c \in blocking
BranchScoped == skipped \subseteq selected
OrdinaryCompleteAlsoUnadmitted == phase = "projected" =>
  ((selected \cap kept \cap failed \cap StockEvidence) \ (admitted \cup results \cup conflicting)) \subseteq skipped
=============================================================================
