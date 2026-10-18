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
 ELSE target.anchor \notin {"old", "recent", "self"} \/ ~target.latestSummary
FirstKeptExpected ==
 IF target.effective = "none" THEN <<"c1", "user">>
 ELSE IF target.effective = "old" THEN <<"summaryOld", "c1", "user">>
 ELSE <<"summaryLatest">> \o
   (CASE target.anchor = "old" -> <<"user">>
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
 target.anchor = "old" /\ target.latestSummary => ~rejected

\* Stock projection owns edit application. The harness verifies its raw source,
\* allows content-only changes with active edit provenance, and never derives
\* recovery/admission from a replacement or an omitted known result.
ProjectionInit ==
 /\ target \in [source: {"selected", "foreign", "altered"},
       content: {"same", "edited", "omitted"}, edit: BOOLEAN,
       identity: {"same", "changed"}, actualResult: BOOLEAN]
 /\ canonical = target /\ phase = "input"
 /\ selectedCalls = {} /\ selectedResults = {} /\ native = {} /\ cut = 0
 /\ projected = <<>> /\ outstanding = {} /\ plans = {} /\ executed = {}
 /\ overlay = FALSE /\ rejected = FALSE /\ failed = {} /\ blocking = {}
 /\ mode = "native" /\ reused = FALSE /\ metadata = "selected-valid"
ProjectionBad == target.source # "selected" \/ target.identity # "same" \/
                 (target.content = "edited" /\ ~target.edit)
ProjectionStep ==
 /\ phase = "input" /\ phase' = "projected"
 /\ rejected' = ProjectionBad
 /\ projected' = IF ProjectionBad \/ target.content = "omitted" THEN <<>> ELSE <<target.content>>
 /\ outstanding' = IF ProjectionBad \/ target.actualResult THEN {} ELSE {"c1"}
 /\ UNCHANGED <<target, mode, metadata, reused, canonical, selectedCalls,
      selectedResults, native, cut, plans, executed, failed, blocking, overlay>>
ProjectionNext == ProjectionStep \/ Plan \/ (phase = "planned" /\ UNCHANGED vars)
ProjectionSpec == ProjectionInit /\ [][ProjectionNext]_vars
ProjectionSource == phase # "input" /\ ~rejected =>
 target.source = "selected" /\ target.identity = "same"
ProjectionEditProvenance == phase # "input" /\ ~rejected /\ target.content = "edited" => target.edit
ProjectionRawRecovery == target.actualResult => plans = {}
ProjectionReject == phase # "input" /\ ProjectionBad => rejected /\ projected = <<>> /\ plans = {}


\* Operation-scoped recovery reuses current selected facts. Projection validity is
\* a separate gate at genuine projection use, including post-append refresh.
\* The alternative spec reuses this module's variables, as FirstKept/Projection do.
CONSTANT RecoveryFault
RecoveryFast == target.registered /\ target.nativeMode
RecoveryBad == target.invalid \in {"timestamp", "config", "fence"}
               \/ (target.invalid = "canonical" /\ RecoveryFault # "canonical-veto")
RecoveryProjectionGood == target.invalid # "projection"
RecoveryPending == (selectedCalls \cap native) \ canonical
RecoveryOrder(rows) == SelectSeq(<<"c1", "c2">>, LAMBDA id: id \in rows)
RecoveryInitialProfiles == {target.initialProfile}
RecoveryInit ==
 /\ target \in [registered: BOOLEAN, nativeMode: BOOLEAN,
       invalid: {"ok", "timestamp", "config", "fence", "canonical", "projection"},
       failAt: {"none", "append", "refresh", "publish", "afterCommit"}, initialProfile: {0, 1}]
 /\ mode = IF target.nativeMode THEN "native" ELSE "ordinary"
 /\ selectedCalls \in {{}, {"c1", "c2"}}
 /\ native = {"c1", "c2"} /\ selectedResults \in SUBSET selectedCalls
 /\ canonical = selectedResults /\ cut \in {1, 5}
 /\ metadata = RecoveryInitialProfiles /\ phase = "input"
 /\ projected = <<>> /\ outstanding = {} /\ plans = <<>> /\ executed = {}
 /\ overlay = FALSE /\ rejected = FALSE /\ reused = 0
 /\ failed = [error |-> FALSE, retried |-> FALSE] /\ blocking = <<>>
RecoveryPlan ==
 LET reject == RecoveryBad \/ (~RecoveryFast /\ ~RecoveryProjectionGood)
     pending == IF RecoveryFault = "retry-duplicate" /\ failed.retried
                THEN (selectedCalls \cap native) \ selectedResults ELSE RecoveryPending
     scoped == IF RecoveryFault = "lose-cold" /\ cut = 5 THEN pending \ {"c1"} ELSE pending
 IN /\ phase = "input"
    /\ plans' = IF reject THEN <<>> ELSE RecoveryOrder(scoped)
    /\ outstanding' = IF reject THEN {} ELSE scoped
    /\ rejected' = reject /\ phase' = IF reject THEN "done" ELSE "planned"
    /\ reused' = reused + (IF ~RecoveryFast \/ RecoveryFault = "eager-view" THEN 1 ELSE 0)
    /\ metadata' = IF RecoveryFast THEN
          (IF RecoveryFault = "clear-profile" THEN {} ELSE metadata)
          ELSE IF RecoveryProjectionGood /\ ~RecoveryBad THEN metadata \cap {1} ELSE metadata
    /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, canonical, cut,
                    projected, executed, overlay, failed, blocking>>
RecoveryNextCall ==
 /\ phase = "planned"
 /\ phase' = IF Len(plans) = 0 THEN "use" ELSE "append"
 /\ blocking' = IF Len(plans) = 0 THEN blocking ELSE Append(blocking, <<Head(plans), "hook">>)
 /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, canonical, cut,
       metadata, projected, outstanding, plans, executed, overlay, rejected, reused, failed>>
RecoveryAppend ==
 /\ phase = "append"
 /\ IF target.failAt = "append" THEN
       /\ failed' = [failed EXCEPT !.error = TRUE] /\ phase' = "done"
       /\ UNCHANGED <<canonical, projected, blocking, executed>>
    ELSE
       /\ canonical' = canonical \cup {Head(plans)}
       /\ projected' = Append(projected, Head(plans))
       /\ blocking' = Append(blocking, <<Head(plans), "append">>)
       /\ executed' = IF RecoveryFault = "replay" THEN {Head(plans)} ELSE executed
       /\ phase' = "refresh" /\ UNCHANGED failed
 /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, cut, metadata,
       outstanding, plans, overlay, rejected, reused>>
RecoveryRefresh ==
 LET good == RecoveryProjectionGood /\ target.failAt # "refresh" IN
 /\ phase = "refresh" /\ reused' = reused + 1
 /\ phase' = IF good THEN "publish" ELSE "done"
 /\ failed' = [failed EXCEPT !.error = ~good]
 /\ metadata' = IF good THEN metadata \cap {1} ELSE metadata
 /\ blocking' = IF good THEN Append(blocking, <<Head(plans), "refresh">>) ELSE blocking
 /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, canonical, cut,
       projected, outstanding, plans, executed, overlay, rejected>>
RecoveryPublish ==
 /\ phase = "publish"
 /\ blocking' = Append(blocking, <<Head(plans), "publish">>)
 /\ phase' = IF target.failAt = "publish" THEN "done" ELSE "afterCommit"
 /\ failed' = [failed EXCEPT !.error = (target.failAt = "publish")]
 /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, canonical, cut,
       metadata, projected, outstanding, plans, executed, overlay, rejected, reused>>
RecoveryAfterCommit ==
 /\ phase = "afterCommit"
 /\ blocking' = Append(blocking, <<Head(plans), "afterCommit">>)
 /\ phase' = IF target.failAt = "afterCommit" THEN "done" ELSE "planned"
 /\ failed' = [failed EXCEPT !.error = (target.failAt = "afterCommit")]
 /\ plans' = Tail(plans)
 /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, canonical, cut,
       metadata, projected, outstanding, executed, overlay, rejected, reused>>
RecoveryUse ==
 LET good == RecoveryProjectionGood \/ RecoveryFault = "projection-use" IN
 /\ phase = "use" /\ phase' = "done" /\ reused' = reused + 1
 /\ overlay' = good /\ rejected' = ~good
 /\ metadata' = IF RecoveryProjectionGood /\ RecoveryFault # "stale-profile"
                THEN metadata \cap {1} ELSE metadata
 /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, canonical, cut,
       projected, outstanding, plans, executed, failed, blocking>>
RecoveryRetry ==
 /\ phase = "done" /\ failed.error /\ ~failed.retried
 /\ phase' = "input" /\ failed' = [error |-> FALSE, retried |-> TRUE]
 /\ UNCHANGED <<target, mode, selectedCalls, selectedResults, native, canonical, cut,
       metadata, projected, outstanding, plans, executed, overlay, rejected, reused, blocking>>
RecoveryNext == RecoveryPlan \/ RecoveryNextCall \/ RecoveryAppend \/ RecoveryRefresh
                \/ RecoveryPublish \/ RecoveryAfterCommit \/ RecoveryUse \/ RecoveryRetry
RecoverySpec == RecoveryInit /\ [][RecoveryNext]_vars
RecoveryNoReplay == executed = {}
RecoveryUnknownOnly == \A i \in DOMAIN projected :
 projected[i] \in (selectedCalls \cap native) \ selectedResults
RecoveryOnce == \A c \in Calls : Count(projected, c) <= 1
RecoveryCanonicalVeto == target.invalid \in {"timestamp", "config", "fence", "canonical"} => projected = <<>>
RecoveryProjectionGate == overlay => RecoveryProjectionGood
RecoveryProfileFreshness == overlay => metadata \subseteq {1}
RecoveryNoProfileGrowth == metadata \subseteq RecoveryInitialProfiles
RecoveryNoPrematureClear == RecoveryFast /\ reused = 0 => metadata = RecoveryInitialProfiles
RecoveryNoDiscardedView == RecoveryFast /\ phase = "planned" /\ Len(projected) = 0 => reused = 0
RecoveryAllSelected == phase = "planned" /\ ~failed.retried /\ Len(projected) = 0 =>
 outstanding = (selectedCalls \cap native) \ selectedResults
RecoveryCommitOrder ==
 \A i \in DOMAIN blocking :
  LET event == blocking[i] IN
  /\ (event[2] = "append" => \E j \in 1..(i-1) : blocking[j] = <<event[1], "hook">>)
  /\ (event[2] = "refresh" => \E j \in 1..(i-1) : blocking[j] = <<event[1], "append">>)
  /\ (event[2] = "publish" => \E j \in 1..(i-1) : blocking[j] = <<event[1], "refresh">>)
  /\ (event[2] = "afterCommit" => \E j \in 1..(i-1) : blocking[j] = <<event[1], "publish">>)

=============================================================================
