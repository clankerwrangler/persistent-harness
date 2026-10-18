-------------------- MODULE DependencyLookup --------------------
EXTENDS Naturals, FiniteSets
CONSTANTS SkipRoot, AllowEscape, AllowMismatch
VARIABLES layout, declared, within, identity, versions, sameAi, publicExports,
          cursor, stage, accepted, visited
vars == <<layout,declared,within,identity,versions,sameAi,publicExports,cursor,stage,accepted,visited>>
Valid == declared /\ within /\ identity /\ versions /\ sameAi /\ publicExports
Init == /\ layout \in {"flat","nested"} /\ declared \in BOOLEAN /\ within \in BOOLEAN
        /\ identity \in BOOLEAN /\ versions \in BOOLEAN /\ sameAi \in BOOLEAN /\ publicExports \in BOOLEAN
        /\ cursor=0 /\ stage="lookup" /\ accepted=FALSE /\ visited={}
CandidateExists == (layout="nested" /\ cursor=1) \/ (layout="flat" /\ cursor=2 /\ ~SkipRoot)
Step == /\ stage="lookup"
        /\ IF cursor=3 \/ ~declared
           THEN /\ stage'="done" /\ accepted'=FALSE /\ UNCHANGED <<cursor,visited>>
           ELSE /\ visited'=visited \cup {cursor}
                /\ IF CandidateExists
                   THEN /\ stage'="done" /\ accepted'=(identity /\ sameAi /\ publicExports
                                      /\ (within \/ AllowEscape) /\ (versions \/ AllowMismatch))
                        /\ UNCHANGED cursor
                   ELSE /\ cursor'=cursor+1 /\ UNCHANGED <<stage,accepted>>
        /\ UNCHANGED <<layout,declared,within,identity,versions,sameAi,publicExports>>
Spec == Init /\ [][Step]_vars
CompleteInstalledGraph == stage="done" /\ Valid => accepted
SelectedGraphOnly == accepted => within
ExactPublicOwners == accepted => declared /\ identity /\ versions /\ sameAi /\ publicExports
NoAncestorProbe == visited \subseteq {0,1,2}
=============================================================================
