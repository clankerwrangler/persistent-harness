------------------------- MODULE ColdHistoryAnchor -------------------------
\* Sources:
\*   src/canonical-context.mjs sha256:95fa4c4c0ef154aa53f5ab90923d3693fa341b4f78e5c60969ad55e7a6fe8fc6
EXTENDS Naturals, Sequences, FiniteSets

\* A session keeps state only after its live-context bookmark. Older facts come
\* from a rebuildable summary file. Entry ids are unique and each names its whole
\* parent chain, so a summary is valid exactly when its entry is on the branch.

CONSTANTS MaxEntries, TrustSummaryOffBranch, TrustPartialSummary, ApplyBookmarkOffBranch

\* saved is what the persisted checkpoint covers, which outlives a rewind.
VARIABLES branch, nextId, bookmark, saved, summary, restored, projected

vars == <<branch, nextId, bookmark, saved, summary, restored, projected>>

NoSummary == [entry |-> 0, facts |-> {}, complete |-> TRUE]

Elements(s) == {s[i] : i \in 1..Len(s)}
OnBranch(id) == id \in Elements(branch)
PositionOf(id) == CHOOSE i \in 1..Len(branch) : branch[i] = id
After(id) == {branch[i] : i \in (PositionOf(id) + 1)..Len(branch)}
Upto(id) == {branch[i] : i \in 1..PositionOf(id)}

\* The result of reading the whole file, which every shortcut must equal.
FullFacts == Elements(branch)
FullContext ==
  IF bookmark /= 0 /\ OnBranch(bookmark)
  THEN [covers |-> Upto(bookmark), raw |-> After(bookmark)]
  ELSE [covers |-> {}, raw |-> Elements(branch)]

SummaryUsable ==
  /\ summary.entry /= 0
  /\ TrustSummaryOffBranch \/ OnBranch(summary.entry)
  /\ TrustPartialSummary \/ summary.complete

Restore ==
  IF SummaryUsable
  THEN summary.facts \cup (IF OnBranch(summary.entry) THEN After(summary.entry) ELSE Elements(branch))
  ELSE FullFacts

\* The bookmark is checked against the branch, never counted.
Project ==
  IF bookmark /= 0 /\ (ApplyBookmarkOffBranch \/ OnBranch(bookmark))
  THEN IF OnBranch(bookmark)
       THEN [covers |-> Upto(bookmark), raw |-> After(bookmark)]
       ELSE [covers |-> saved, raw |-> Elements(branch)]
  ELSE [covers |-> {}, raw |-> Elements(branch)]

Init ==
  /\ branch = <<>>
  /\ nextId = 1
  /\ bookmark = 0
  /\ saved = {}
  /\ summary = NoSummary
  /\ restored = {}
  /\ projected = [covers |-> {}, raw |-> {}]

AppendEntry ==
  /\ nextId <= MaxEntries
  /\ branch' = Append(branch, nextId)
  /\ nextId' = nextId + 1
  /\ restored' = restored \cup {nextId}
  /\ projected' = [projected EXCEPT !.raw = @ \cup {nextId}]
  /\ UNCHANGED <<bookmark, saved, summary>>

Checkpoint ==
  /\ Len(branch) > 0
  /\ bookmark' = branch[Len(branch)]
  /\ saved' = Elements(branch)
  /\ projected' = [covers |-> Elements(branch), raw |-> {}]
  /\ UNCHANGED <<branch, nextId, summary, restored>>

\* Writes go through a rename, so only a crash in the unchecked variant leaves a part.
WriteSummary ==
  /\ bookmark /= 0
  /\ OnBranch(bookmark)
  /\ summary' = [entry |-> bookmark, facts |-> Upto(bookmark), complete |-> TRUE]
  /\ UNCHANGED <<branch, nextId, bookmark, saved, restored, projected>>

CrashWhileWriting ==
  /\ TrustPartialSummary
  /\ bookmark /= 0
  /\ OnBranch(bookmark)
  /\ summary' = [entry |-> bookmark, facts |-> {}, complete |-> FALSE]
  /\ UNCHANGED <<branch, nextId, bookmark, saved, restored, projected>>

Restart ==
  /\ restored' = Restore
  /\ projected' = Project
  /\ UNCHANGED <<branch, nextId, bookmark, saved, summary>>

Rewind ==
  /\ Len(branch) > 0
  /\ \E keep \in 0..(Len(branch) - 1) :
       /\ branch' = SubSeq(branch, 1, keep)
       /\ restored' = Elements(branch')
       /\ UNCHANGED <<nextId, bookmark, saved, summary>>
       /\ projected' = IF bookmark /= 0 /\ bookmark \in Elements(branch')
                       THEN [projected EXCEPT !.raw = @ \cap Elements(branch')]
                       ELSE [covers |-> {}, raw |-> Elements(branch')]

Next == AppendEntry \/ Checkpoint \/ WriteSummary \/ CrashWhileWriting \/ Restart \/ Rewind

FactsMatchFullRead == restored = FullFacts

ContextMatchesFullRead ==
  (projected.covers = {} \/ projected.covers \subseteq Elements(branch))
  /\ (projected.covers \cup projected.raw) = Elements(branch)
  /\ projected.covers \cap projected.raw = {}

Spec == Init /\ [][Next]_vars
=============================================================================
