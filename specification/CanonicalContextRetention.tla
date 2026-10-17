-------------------- MODULE CanonicalContextRetention --------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC
CONSTANTS MaxChanges, BadIgnoreLeafChanges, BadDropColdFacts, BadIgnoreGeneration, BadHydrateEmpty, BadEagerSource, BadProfileStamp, BadColdReread, BadColdPayload, BadPhysicalFold
VARIABLES count, leaf, revision, generation, changes, keep, signatureConflict, rawNative, factNative, factGeneration,
          factRevision, factLeaf, facts, projectedRevision, pending, omitted,
          rejected, hydrated, sourceOnly, profileKey, profileTokens, estimatedRevision, estimatedTokens, coldReads, foldReads, coldPayloads, foldOrder
vars == <<count, leaf, revision, generation, changes, keep, signatureConflict, rawNative, factNative, factGeneration,
          factRevision, factLeaf, facts, projectedRevision, pending, omitted,
          rejected, hydrated, sourceOnly, profileKey, profileTokens, estimatedRevision, estimatedTokens, coldReads, foldReads, coldPayloads, foldOrder>>
Order == <<"c1", "r1", "o1", "c2", "s1">>
PhysicalOrder == <<"r1", "c1", "s1", "o1", "c2">>
Ids == {"c1", "r1", "o1", "c2", "s1"}
Parent == [c1 |-> "root", r1 |-> "c1", o1 |-> "r1", c2 |-> "o1", s1 |-> "c1"]
AsSet(seq) == {seq[i] : i \in DOMAIN seq}
RECURSIVE Path(_)
Path(id) == IF id = "root" THEN <<>> ELSE Path(Parent[id]) \o <<id>>
Selected == Path(leaf)
SelectedSet == AsSet(Selected)
Active == AsSet(SubSeq(Selected, IF Len(Selected) > keep THEN Len(Selected)-keep+1 ELSE 1,
                        Len(Selected)))
\* c1 is a native call; r1 is its real result. o1 is an orphan result whose
\* plain provider-call alias vetoes omission of the failed ordinary tuple c2.
\* s1 is a sibling signature amendment and an observed-terminal veto.
\* o1 is a nonproducing metadata group; s1 is an omission/edit source.
Producing == Active \ {"o1", "s1"}
Outstanding(rows, native) == IF native /\ "c1" \in rows /\ "r1" \notin rows THEN {"c1"} ELSE {}
Invalid(rows) == "s1" \in rows /\ signatureConflict
Omitted(rows) == IF "c2" \in Active /\ "c2" \in rows /\
                    "o1" \notin rows /\ "s1" \notin rows THEN {"c2"} ELSE {}
Compact(rows) == IF BadDropColdFacts THEN rows \ (rows \ Active) ELSE rows
PhysicalSelected == SelectSeq(PhysicalOrder, LAMBDA id: id \in SelectedSet)
Init == /\ count = 1 /\ leaf = "c1" /\ revision = 0 /\ generation = 0 /\ changes = 0
        /\ rawNative \in BOOLEAN /\ factNative = FALSE /\ factGeneration = -1
        /\ keep \in {1, 2} /\ signatureConflict \in BOOLEAN
        /\ factRevision = -1 /\ factLeaf = "root" /\ facts = {}
        /\ projectedRevision = -1 /\ pending = {} /\ omitted = {}
        /\ rejected = FALSE /\ hydrated = {} /\ sourceOnly = FALSE
        /\ coldReads = 0 /\ foldReads = 0 /\ coldPayloads = {} /\ foldOrder = <<>>
        /\ profileKey = <<"none">> /\ profileTokens = 0 /\ estimatedRevision = -1 /\ estimatedTokens = 0
Rebuild == /\ (factRevision # revision \/ factGeneration # generation)
           /\ coldReads' = count
           /\ foldReads' = IF BadColdReread THEN Len(Selected) ELSE 0
           /\ coldPayloads' = IF BadColdPayload THEN SelectedSet ELSE {}
           /\ foldOrder' = IF BadPhysicalFold THEN PhysicalSelected ELSE Selected
           /\ facts' = Compact(SelectedSet)
           /\ factRevision' = revision /\ factLeaf' = leaf /\ factGeneration' = generation /\ factNative' = rawNative
           /\ hydrated' = SelectedSet
           /\ UNCHANGED <<count, leaf, revision, generation, changes, keep, signatureConflict, rawNative,
                           projectedRevision, pending, omitted, rejected, sourceOnly, profileKey, profileTokens, estimatedRevision, estimatedTokens>>
AppendEntry ==
  LET next == Order[count+1]
      incremental == factRevision = revision /\ factGeneration = generation /\ Parent[next] = leaf IN
  /\ changes < MaxChanges /\ count < Len(Order)
  /\ count' = count+1 /\ leaf' = next /\ revision' = revision+1 /\ changes' = changes+1
  /\ facts' = (IF incremental THEN Compact(facts \cup {next}) ELSE facts)
  /\ factRevision' = (IF incremental THEN revision+1 ELSE factRevision)
  /\ factLeaf' = (IF incremental THEN next ELSE factLeaf)
  /\ hydrated' = {next}
  /\ foldOrder' = IF incremental THEN Append(foldOrder, next) ELSE foldOrder
  /\ UNCHANGED <<coldReads, foldReads, coldPayloads, keep, signatureConflict, rawNative, factNative, factGeneration, generation, projectedRevision, pending, omitted, rejected, sourceOnly, profileKey, profileTokens, estimatedRevision, estimatedTokens>>
MoveLeaf == /\ changes < MaxChanges
            /\ leaf' \in AsSet(SubSeq(Order, 1, count)) \cup {"root"}
            /\ revision' = (IF BadIgnoreLeafChanges THEN revision ELSE revision+1)
            /\ changes' = changes+1
            /\ UNCHANGED <<coldReads, foldReads, coldPayloads, foldOrder, count, keep, signatureConflict, rawNative, factNative, factGeneration, generation, factRevision, factLeaf,
                            facts, projectedRevision, pending, omitted, rejected, hydrated, sourceOnly, profileKey, profileTokens, estimatedRevision, estimatedTokens, profileKey, profileTokens, estimatedRevision, estimatedTokens>>
Project == /\ factRevision = revision /\ (BadIgnoreGeneration \/ factGeneration = generation)
           /\ projectedRevision' = revision
           /\ rejected' = Invalid(facts)
           /\ pending' = (IF Invalid(facts) THEN {} ELSE Outstanding(facts, factNative))
           /\ omitted' = (IF Invalid(facts) THEN {} ELSE Omitted(facts))
           /\ sourceOnly' = FALSE
           /\ hydrated' = (IF BadHydrateEmpty THEN Active ELSE Producing) \cup (IF Invalid(facts) THEN {} ELSE Outstanding(facts, factNative))
           /\ UNCHANGED <<coldReads, foldReads, coldPayloads, foldOrder, count, leaf, revision, generation, changes, keep, signatureConflict, rawNative, factNative, factGeneration,
                           factRevision, factLeaf, facts, profileKey, profileTokens, estimatedRevision, estimatedTokens>>
Reload == /\ changes < MaxChanges
  /\ count' = Len(Order) /\ leaf' = "s1" /\ rawNative' = ~rawNative
  /\ revision' = revision+1 /\ generation' = generation+1 /\ changes' = changes+1
  /\ facts' = (IF BadIgnoreGeneration THEN {"c1", "s1"} ELSE facts)
  /\ factLeaf' = (IF BadIgnoreGeneration THEN "s1" ELSE factLeaf)
  /\ factRevision' = (IF BadIgnoreGeneration THEN revision+1 ELSE factRevision)
  /\ UNCHANGED <<coldReads, foldReads, coldPayloads, foldOrder, keep, signatureConflict, factGeneration, factNative,
                  projectedRevision, pending, omitted, rejected, hydrated, sourceOnly, profileKey, profileTokens, estimatedRevision, estimatedTokens, profileKey, profileTokens, estimatedRevision, estimatedTokens>>
BuildSource == /\ factRevision = revision /\ factGeneration = generation
  /\ projectedRevision' = revision /\ sourceOnly' = TRUE
  /\ rejected' = Invalid(facts)
  /\ pending' = (IF Invalid(facts) THEN {} ELSE Outstanding(facts, factNative))
  /\ omitted' = (IF Invalid(facts) THEN {} ELSE Omitted(facts))
  /\ hydrated' = (IF BadEagerSource THEN Producing ELSE {})
  /\ UNCHANGED <<coldReads, foldReads, coldPayloads, foldOrder, count, leaf, revision, generation, changes, keep, signatureConflict,
       rawNative, factNative, factGeneration, factRevision, factLeaf, facts, profileKey, profileTokens, estimatedRevision, estimatedTokens>>
ExpectedTokens == Cardinality(Producing) + (IF rawNative THEN 1 ELSE 0)
ProfileStamp == IF BadProfileStamp THEN <<Producing, Omitted(facts)>>
                ELSE <<generation, Producing, Omitted(facts), rawNative>>
Estimate == /\ factRevision = revision /\ factGeneration = generation
  /\ estimatedRevision' = revision
  /\ estimatedTokens' = (IF profileKey = ProfileStamp THEN profileTokens ELSE ExpectedTokens)
  /\ profileKey' = ProfileStamp /\ profileTokens' = estimatedTokens'
  /\ UNCHANGED <<coldReads, foldReads, coldPayloads, foldOrder, count, leaf, revision, generation, changes, keep, signatureConflict, rawNative, factNative,
       factGeneration, factRevision, factLeaf, facts, projectedRevision, pending, omitted, rejected, hydrated, sourceOnly>>
Next == Rebuild \/ AppendEntry \/ MoveLeaf \/ Reload \/ Project \/ BuildSource \/ Estimate
Spec == Init /\ [][Next]_vars
UsageParity == estimatedRevision = revision => estimatedTokens = ExpectedTokens
ColdSingleIngest == coldReads <= Len(Order) /\ foldReads = 0
NoRetainedColdBodies == coldPayloads = {}
SelectedFoldOrder == factRevision = revision /\ factGeneration = generation => foldOrder = Selected
TypeOK == /\ count \in 1..Len(Order) /\ leaf \in Ids \cup {"root"}
          /\ facts \subseteq Ids /\ changes \in 0..MaxChanges
LeafScopedFacts == factRevision = revision /\ factGeneration = generation => factLeaf = leaf /\ facts = SelectedSet
SourceGeneration == factRevision = revision /\ (BadIgnoreGeneration \/ factGeneration = generation) => factNative = rawNative
ColdNativeFacts == projectedRevision = revision =>
  pending = IF Invalid(SelectedSet) THEN {} ELSE Outstanding(SelectedSet, rawNative)
FullBranchVeto == projectedRevision = revision =>
  omitted = IF Invalid(SelectedSet) THEN {} ELSE Omitted(SelectedSet)
BranchLocalSignature == projectedRevision = revision => rejected = Invalid(SelectedSet)
\* Outstanding native calls are genuine working state even outside the compacted
\* model view; their restoration must not be mistaken for cold archive retention.
NormalPayloadScope == projectedRevision = revision =>
  hydrated = (IF sourceOnly THEN {} ELSE Producing \cup pending)
=============================================================================
