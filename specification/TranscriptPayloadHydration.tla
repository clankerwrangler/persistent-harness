-------------------- MODULE TranscriptPayloadHydration --------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Views, Rows, Fault
VARIABLES version, bytes, branch, generation, cached, cacheVersion, cacheBranch,
          cacheGeneration, charge, pendingView, pendingBacking, phase, boundVersion,
          boundBytes, boundBranch, boundGeneration, verify, view, cursorBranch,
          lease, intact, blocked, cachePayload, resultView, resultRows, accepted,
          hashProven, fingerprintProven, cursorProven
vars == <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
          cacheGeneration,charge,pendingView,pendingBacking,phase,boundVersion,
          boundBytes,boundBranch,boundGeneration,verify,view,cursorBranch,lease,
          intact,blocked,cachePayload,resultView,resultRows,accepted,
          hashProven,fingerprintProven,cursorProven>>
Budget == 3
Metadata == 2
Expected(v) == IF v="index" THEN Rows ELSE {CHOOSE r \in Rows: TRUE}
Init == /\ version=0 /\ bytes=1 /\ branch=0 /\ generation=0
        /\ cached=TRUE /\ cacheVersion=0 /\ cacheBranch=0 /\ cacheGeneration=0
        /\ charge=Metadata /\ pendingView=0 /\ pendingBacking=0 /\ phase="idle"
        /\ boundVersion=0 /\ boundBytes=1 /\ boundBranch=0 /\ boundGeneration=0
        /\ verify=FALSE /\ view=(CHOOSE v \in Views: TRUE) /\ cursorBranch=0
        /\ lease={} /\ intact=TRUE /\ blocked=FALSE /\ cachePayload=FALSE
        /\ resultView=view /\ resultRows={} /\ accepted=FALSE
        /\ hashProven=FALSE /\ fingerprintProven=FALSE /\ cursorProven=FALSE
Begin(v,strict) == /\ phase="idle" /\ view'=v /\ verify'=strict /\ phase'="working"
                  /\ boundVersion'=(IF cached THEN cacheVersion ELSE version)
                  /\ boundBranch'=(IF cached THEN cacheBranch ELSE branch)
                  /\ boundGeneration'=(IF cached THEN cacheGeneration ELSE generation)
                  /\ boundBytes'=bytes /\ cached'=FALSE /\ charge'=0
                  /\ UNCHANGED <<version,bytes,branch,generation,cacheVersion,cacheBranch,
                       cacheGeneration,pendingView,pendingBacking,cursorBranch,lease,
                       intact,blocked,cachePayload,resultView,resultRows,accepted,
                       hashProven,fingerprintProven,cursorProven>>
Reconcile == /\ phase="working" /\ phase'="ready"
             /\ boundVersion'=version /\ boundBytes'=bytes /\ boundBranch'=branch
             /\ boundGeneration'=generation
             /\ UNCHANGED <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
                  cacheGeneration,charge,pendingView,pendingBacking,verify,view,cursorBranch,
                  lease,intact,blocked,cachePayload,resultView,resultRows,accepted,
                  hashProven,fingerprintProven,cursorProven>>
OwnedAppend == /\ phase="working" /\ bytes=2
               /\ (boundGeneration=generation \/ Fault="owned-prefix")
               /\ boundBytes'=bytes /\ phase'="ready"
               /\ UNCHANGED <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
                    cacheGeneration,charge,pendingView,pendingBacking,boundVersion,boundBranch,
                    boundGeneration,verify,view,cursorBranch,lease,intact,blocked,cachePayload,
                    resultView,resultRows,accepted,hashProven,fingerprintProven,cursorProven>>
Select(c) == /\ phase="ready" /\ cursorBranch'=c
             /\ cursorProven'=(c=boundBranch)
             /\ phase'=(IF c=boundBranch \/ Fault="cursor" THEN "hydrating" ELSE "failed")
             /\ lease'=(IF phase'="hydrating" THEN Expected(view) ELSE {})
             /\ UNCHANGED <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
                  cacheGeneration,charge,pendingView,pendingBacking,boundVersion,boundBytes,
                  boundBranch,boundGeneration,verify,view,intact,blocked,cachePayload,
                  resultView,resultRows,accepted,hashProven,fingerprintProven>>
Hydrate == /\ phase="hydrating"
           /\ hashProven'=(version=boundVersion)
           /\ fingerprintProven'=(version=boundVersion /\ bytes=boundBytes /\ branch=boundBranch)
           /\ LET hashes==hashProven' \/ Fault="hash"
                   fingerprint==~verify \/ fingerprintProven' \/ Fault="fingerprint"
               IN phase'=(IF hashes /\ fingerprint THEN "snapshot" ELSE "failed")
           /\ UNCHANGED <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
                cacheGeneration,charge,pendingView,pendingBacking,boundVersion,boundBytes,
                boundBranch,boundGeneration,verify,view,cursorBranch,lease,intact,blocked,
                cachePayload,resultView,resultRows,accepted,cursorProven>>
Publish == /\ phase="snapshot"
           /\ LET weight==Metadata+(IF Fault="pending" THEN pendingView ELSE pendingBacking)
               IN /\ cached'=(~blocked /\ weight<=Budget)
                  /\ charge'=(IF cached' THEN weight ELSE 0)
           /\ cacheVersion'=boundVersion /\ cacheBranch'=boundBranch
           /\ cacheGeneration'=boundGeneration
           /\ cachePayload'=(cached' /\ Fault="payload")
           /\ phase'="returning"
           /\ UNCHANGED <<version,bytes,branch,generation,pendingView,pendingBacking,
                boundVersion,boundBytes,boundBranch,boundGeneration,verify,view,cursorBranch,
                lease,intact,blocked,resultView,resultRows,accepted,
                hashProven,fingerprintProven,cursorProven>>
Return == /\ phase="returning" /\ phase'="done" /\ accepted'=TRUE
          /\ resultView'=(IF Fault="view" THEN (CHOOSE v \in Views: v#view) ELSE view)
          /\ resultRows'=lease /\ lease'={}
          /\ UNCHANGED <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
               cacheGeneration,charge,pendingView,pendingBacking,boundVersion,boundBytes,
               boundBranch,boundGeneration,verify,view,cursorBranch,intact,blocked,
               cachePayload,hashProven,fingerprintProven,cursorProven>>
Evict == /\ cached /\ cached'=FALSE /\ charge'=0 /\ cachePayload'=FALSE
         /\ intact'=(IF Fault="destroy" /\ phase="returning" THEN FALSE ELSE intact)
         /\ UNCHANGED <<version,bytes,branch,generation,cacheVersion,cacheBranch,
              cacheGeneration,pendingView,pendingBacking,phase,boundVersion,boundBytes,
              boundBranch,boundGeneration,verify,view,cursorBranch,lease,blocked,
              resultView,resultRows,accepted,hashProven,fingerprintProven,cursorProven>>
Clear == /\ cached'=FALSE /\ charge'=0 /\ cachePayload'=FALSE
         /\ blocked'=(IF phase \in {"working","ready","hydrating","snapshot"} THEN TRUE ELSE blocked)
         /\ UNCHANGED <<version,bytes,branch,generation,cacheVersion,cacheBranch,
              cacheGeneration,pendingView,pendingBacking,phase,boundVersion,boundBytes,
              boundBranch,boundGeneration,verify,view,cursorBranch,lease,intact,
              resultView,resultRows,accepted,hashProven,fingerprintProven,cursorProven>>
Pending == /\ phase \in {"ready","hydrating"} /\ pendingBacking=0
           /\ pendingView'=1 /\ pendingBacking'=2
           /\ UNCHANGED <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
                cacheGeneration,charge,phase,boundVersion,boundBytes,boundBranch,boundGeneration,
                verify,view,cursorBranch,lease,intact,blocked,cachePayload,resultView,resultRows,
                accepted,hashProven,fingerprintProven,cursorProven>>
SourceChange(v,b,g) == /\ version'=v /\ bytes'=b /\ branch'=g
                       /\ generation'=(IF v#version \/ g#branch THEN 1 ELSE generation)
                       /\ UNCHANGED <<cached,cacheVersion,cacheBranch,cacheGeneration,charge,
                            pendingView,pendingBacking,phase,boundVersion,boundBytes,boundBranch,
                            boundGeneration,verify,view,cursorBranch,lease,intact,blocked,
                            cachePayload,resultView,resultRows,accepted,
                            hashProven,fingerprintProven,cursorProven>>
Abort == /\ phase \in {"working","ready","hydrating","snapshot"}
         /\ phase'="failed" /\ lease'={}
         /\ UNCHANGED <<version,bytes,branch,generation,cached,cacheVersion,cacheBranch,
              cacheGeneration,charge,pendingView,pendingBacking,boundVersion,boundBytes,
              boundBranch,boundGeneration,verify,view,cursorBranch,intact,blocked,cachePayload,
              resultView,resultRows,accepted,hashProven,fingerprintProven,cursorProven>>
Next == (\E v \in Views, strict \in BOOLEAN: Begin(v,strict)) \/ Reconcile \/ OwnedAppend
        \/ (\E c \in 0..1: Select(c)) \/ Hydrate \/ Publish \/ Return \/ Evict \/ Clear
        \/ Pending \/ Abort
        \/ (version=0 /\ SourceChange(1,bytes,branch))
        \/ (bytes=1 /\ SourceChange(version,2,branch))
        \/ (branch=0 /\ SourceChange(version,bytes,1))
Spec == Init /\ [][Next]_vars
OwnedBudget == charge<=Budget /\ (cached => Metadata+pendingBacking<=Budget)
NoCachedPayload == ~cachePayload
NoWorkingCache == phase \in {"working","ready","hydrating","snapshot"} => ~cached
ClearFence == blocked => ~cached
LeaseIntact == intact
SpanDigestFence == accepted => hashProven
FingerprintFence == accepted /\ verify => fingerprintProven
CursorFence == accepted => cursorProven
ResultContract == accepted => resultView=view /\ resultRows=Expected(view)
TypeOK == /\ version \in 0..1 /\ bytes \in 1..2 /\ branch \in 0..1
          /\ pendingView \in 0..1 /\ pendingBacking \in {0,2} /\ lease \subseteq Rows
=============================================================================
