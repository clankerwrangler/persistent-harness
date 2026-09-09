------------------------ MODULE CanonicalContext ------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
\* Read-only projection/recovery model. Tokens stand for immutable messages,
\* including all content/usage/provenance bytes. The injected STOCK helper owns
\* compaction selection; cut abstracts its retained suffix.
CONSTANT Calls, Results
VARIABLES selectedCalls, selectedResults, target, native, cut, mode, reused,
          metadata, phase, canonical, projected, outstanding, plans, executed,
          overlay, rejected, failed, blocking
vars == <<selectedCalls, selectedResults, target, native, cut, mode, reused,
          metadata, phase, canonical, projected, outstanding, plans, executed,
          overlay, rejected, failed, blocking>>
Order == <<"c1", "c2", "r1", "r2", "user">>
IsSelected(x) == x \in selectedCalls \cup selectedResults \cup {"user"}
Branch == SelectSeq(Order, IsSelected)
Kept == SelectSeq(SubSeq(Order, cut, Len(Order)), IsSelected)
Context == <<"summary">> \o Kept
KeptSet == {Kept[i] : i \in DOMAIN Kept}
Matches(c) == {r \in selectedResults : target[r] = c}
Bad == (reused /\ Cardinality(selectedCalls) = 2)
       \/ (\E c \in Calls : Cardinality(Matches(c)) > 1)
       \/ metadata = "selected-conflict"
Movable == {r \in selectedResults :
             target[r] \in native \cap selectedCalls /\
             r \in {Kept[i] : i \in DOMAIN Kept} /\
             target[r] \in {Kept[i] : i \in DOMAIN Kept}}
RECURSIVE Replay(_)
Replay(s) == IF Len(s) = 0 THEN <<>> ELSE
  LET x == Head(s) IN
    (IF mode = "ordinary" /\ x \in Movable THEN <<>>
     ELSE IF mode = "ordinary" /\ x \in selectedCalls /\
                  \E r \in Movable : target[r] = x
          THEN <<x, CHOOSE r \in Movable : target[r] = x>>
          ELSE <<x>>) \o Replay(Tail(s))
Init == /\ selectedCalls \in SUBSET Calls
        /\ selectedResults \in SUBSET Results
        /\ target \in [Results -> Calls \cup {"orphan"}]
        /\ native \in { {"c1"}, Calls }
        /\ cut \in 1..5
        /\ mode \in {"native", "ordinary"}
        /\ reused \in BOOLEAN
        /\ failed \in SUBSET Calls
        /\ blocking = {}
        /\ metadata \in {"selected-valid", "selected-conflict", "excluded-conflict"}
        /\ phase = "input"
        /\ canonical = Branch
        /\ projected = <<>> /\ outstanding = {} /\ plans = {}
        /\ executed = {} /\ overlay = FALSE /\ rejected = FALSE
Project == /\ phase = "input"
           /\ rejected' = Bad
           /\ blocking' = IF Bad \/ mode = "native" THEN {} ELSE
                 {c \in selectedCalls \cap KeptSet :
                   c \in failed \/ Matches(c) \cap KeptSet = {}}
           /\ projected' = IF Bad THEN <<>> ELSE Replay(Context)
           /\ outstanding' = IF Bad THEN {} ELSE
                 {c \in selectedCalls \cap native : Matches(c) = {}}
           /\ overlay' = (~Bad /\ metadata = "selected-valid")
           /\ phase' = "projected"
           /\ UNCHANGED <<selectedCalls, selectedResults, target, native, cut,
                          mode, reused, metadata, canonical, plans, executed, failed>>
Plan == /\ phase = "projected"
        /\ plans' = outstanding
        /\ phase' = "planned"
        /\ UNCHANGED <<selectedCalls, selectedResults, target, native, cut,
                       mode, reused, metadata, canonical, projected,
                       outstanding, executed, overlay, rejected, failed, blocking>>
Next == Project \/ Plan \/ (phase = "planned" /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
Count(s, x) == Cardinality({i \in DOMAIN s : s[i] = x})
CanonicalUnchanged == canonical = Branch
NoEffectReplay == executed = {}
UnknownOnly == \A c \in plans : c \in selectedCalls \cap native /\ Matches(c) = {}
NoPruningRecovery == phase = "planned" /\ ~Bad =>
                      plans = {c \in selectedCalls \cap native : Matches(c) = {}}
RejectAmbiguity == phase # "input" /\ Bad =>
                    rejected /\ projected = <<>> /\ plans = {}
PreserveMessages == phase # "input" /\ ~Bad =>
                     \A x \in {"summary", "user"} \cup Calls \cup Results :
                       Count(projected, x) = Count(Context, x)
KnownOnce == phase # "input" /\ ~Bad /\ mode = "ordinary" =>
              \A r \in Movable :
                \E i \in 1..(Len(projected)-1) :
                  projected[i] = target[r] /\ projected[i+1] = r
NativeOrder == phase # "input" /\ ~Bad /\ mode = "native" => projected = Context
BranchMetadata == overlay => metadata = "selected-valid"
OrdinaryBlocking == phase # "input" /\ ~Bad /\ mode = "ordinary" =>
  \A c \in selectedCalls \cap KeptSet :
    (c \in failed \/ Matches(c) \cap KeptSet = {}) => c \in blocking

\* Actual coding-SDK firstKept parity only. Unused retainedTail data is never
\* interpreted as messages, results, or a writer format. Old anchors are only
\* relevant when the old checkpoint is itself the effective selected checkpoint.
FirstKeptBad ==
 IF target.effective = "none" THEN FALSE
 ELSE IF target.effective = "old" THEN
    target.oldAnchor # "valid" \/ ~target.oldSummary
 ELSE target.anchor \notin {"old", "recent", "self"} \/ ~target.latestSummary \/
      (target.anchor = "old" /\ ~target.oldSummary)
FirstKeptExpected ==
 IF target.effective = "none" THEN <<"c1", "user">>
 ELSE IF target.effective = "old" THEN <<"summaryOld", "c1", "user">>
 ELSE <<"summaryLatest">> \o
   (CASE target.anchor = "old" -> <<"summaryOld", "user">>
      [] target.anchor = "recent" -> <<"user">>
      [] OTHER -> <<>>)
FirstKeptInit ==
 /\ target \in [effective: {"none", "old", "latest"},
       anchor: {"old", "recent", "self", "missing", "sibling", "later"},
       oldAnchor: {"valid", "missing", "sibling"},
       oldSummary: BOOLEAN, latestSummary: BOOLEAN, actualResult: BOOLEAN,
       unusedTail: SUBSET {"c1", "r1"}]
 /\ canonical = target /\ phase = "input"
 /\ selectedCalls = {} /\ selectedResults = {} /\ native = {} /\ cut = 0
 /\ projected = <<>> /\ outstanding = {} /\ plans = {} /\ executed = {}
 /\ overlay = FALSE /\ rejected = FALSE /\ failed = {} /\ blocking = {}
 /\ mode = "native" /\ reused = FALSE /\ metadata = "selected-valid"
FirstKeptProject ==
 /\ phase = "input"
 /\ rejected' = FirstKeptBad
 /\ projected' = IF FirstKeptBad THEN <<>> ELSE FirstKeptExpected
 /\ outstanding' = IF FirstKeptBad \/ target.actualResult THEN {} ELSE {"c1"}
 /\ phase' = "projected"
 /\ UNCHANGED <<target, mode, metadata, reused, canonical, selectedCalls,
      selectedResults, native, cut, plans, executed, failed, blocking, overlay>>
FirstKeptNext == FirstKeptProject \/ Plan \/ (phase = "planned" /\ UNCHANGED vars)
FirstKeptSpec == FirstKeptInit /\ [][FirstKeptNext]_vars
FirstKeptImmutable == canonical = target
FirstKeptNoReplay == executed = {}
FirstKeptParity == phase # "input" /\ ~FirstKeptBad => projected = FirstKeptExpected
FirstKeptInvalidVisible == phase # "input" /\ FirstKeptBad => rejected /\ projected = <<>> /\ plans = {}
FirstKeptKnownOnly == target.actualResult => plans = {}
FirstKeptTailNotResult == phase = "planned" /\ ~FirstKeptBad /\ ~target.actualResult => plans = {"c1"}
FirstKeptObsoleteIgnored == phase # "input" /\ target.effective = "latest" /\
 target.anchor \in {"recent", "self"} /\ target.latestSummary => ~rejected
FirstKeptRetainedOldSummary == phase # "input" /\ target.effective = "latest" /\
 target.anchor = "old" /\ ~target.oldSummary => rejected

=============================================================================
