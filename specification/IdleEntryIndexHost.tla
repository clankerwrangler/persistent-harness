-------------------- MODULE IdleEntryIndexHost --------------------
EXTENDS Naturals, FiniteSets
CONSTANTS AwaitAdmission, AwaitClose, DropWakeCancel, CancelWrongToken,
          AdmitBusy, PerGenerationPath, CanonicalWrite, LateClear, DispatchStale, DrainNormalEarly
VARIABLES stage, generation, issued, host, tasks, taskGeneration, cancelled,
          wire, aborted, busy, pending, wakeOwner, attempted, revision,
          sourceRevision, admission, stopped, published, cacheKey, lostOwner,
          badDispatch, canonicalByPreparation, normalRequests, shutdownRequested, drainedEarly
vars == <<stage,generation,issued,host,tasks,taskGeneration,cancelled,wire,aborted,
          busy,pending,wakeOwner,attempted,revision,sourceRevision,admission,stopped,
          published,cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
Ids == {1,2}
Live == {i \in 1..issued: tasks[i] \in {"scheduled","reading","sealed"}
                           /\ taskGeneration[i] = generation}
CanDispatch(i) == /\ ~shutdownRequested /\ host = i /\ taskGeneration[i] = generation
                  /\ stage = "idle" /\ ~busy /\ ~pending /\ ~wakeOwner
                  /\ i \notin cancelled
Init == /\ stage = "idle" /\ generation = 1 /\ issued = 0 /\ host = 0
        /\ tasks = [i \in Ids |-> "none"] /\ taskGeneration = [i \in Ids |-> 0]
        /\ cancelled = {} /\ wire = {} /\ aborted = {}
        /\ busy \in BOOLEAN /\ pending \in BOOLEAN /\ wakeOwner = FALSE
        /\ attempted = FALSE /\ revision = 0 /\ sourceRevision = [i \in Ids |-> 0]
        /\ admission = FALSE /\ stopped = FALSE /\ published = {}
        /\ cacheKey = "none" /\ lostOwner = FALSE /\ badDispatch = FALSE
        /\ canonicalByPreparation = FALSE /\ normalRequests=0 /\ shutdownRequested=FALSE /\ drainedEarly=FALSE
Schedule == /\ stage = "idle" /\ ~attempted /\ host = 0 /\ issued < 2
            /\ ~wakeOwner /\ ~pending /\ ~shutdownRequested
            /\ issued' = issued + 1 /\ host' = issued + 1
            /\ tasks' = [tasks EXCEPT ![issued+1] = "scheduled"]
            /\ taskGeneration' = [taskGeneration EXCEPT ![issued+1] = generation]
            /\ UNCHANGED <<stage,generation,cancelled,wire,aborted,busy,pending,wakeOwner,
                 attempted,revision,sourceRevision,admission,stopped,published,cacheKey,
                 lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
Dispatch(i) == /\ tasks[i] = "scheduled"
               /\ (CanDispatch(i) \/ (AdmitBusy /\ host=i /\ taskGeneration[i]=generation /\ stage="idle"
                   /\ ~pending /\ ~wakeOwner /\ i \notin cancelled) \/ DispatchStale)
               /\ tasks' = [tasks EXCEPT ![i] = "reading"] /\ attempted' = TRUE
               /\ sourceRevision' = [sourceRevision EXCEPT ![i] = revision]
               /\ badDispatch' = (badDispatch \/ ~CanDispatch(i))
               /\ UNCHANGED <<stage,generation,issued,host,taskGeneration,cancelled,wire,
                    aborted,busy,pending,wakeOwner,revision,admission,stopped,published,
                    cacheKey,lostOwner,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
\* Automatic readiness runs after the settled callback schedules a deferred
\* attempt. Cancellation before dispatch must leave the interval unconsumed.
Wake == /\ stage = "idle" /\ ~wakeOwner /\ wakeOwner' = TRUE
        /\ admission' = ~(AwaitAdmission /\ Live # {})
        /\ cancelled' = IF DropWakeCancel THEN cancelled ELSE cancelled \cup Live
        /\ wire' = wire \cup {i \in Live: tasks[i] # "scheduled"}
        /\ host' = 0
        /\ UNCHANGED <<stage,generation,issued,tasks,taskGeneration,aborted,busy,pending,
             attempted,revision,sourceRevision,stopped,published,cacheKey,lostOwner,
             badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
DrainWake == /\ wakeOwner /\ wakeOwner' = FALSE /\ pending' = FALSE
             /\ UNCHANGED <<stage,generation,issued,host,tasks,taskGeneration,cancelled,wire,
                  aborted,busy,attempted,revision,sourceRevision,admission,stopped,published,
                  cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
StartWork == /\ wakeOwner /\ stage = "idle" /\ stage' = "working"
             /\ attempted' = FALSE
             /\ UNCHANGED <<generation,issued,host,tasks,taskGeneration,cancelled,wire,aborted,
                  busy,pending,wakeOwner,revision,sourceRevision,admission,stopped,published,
                  cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
Settle == /\ stage = "working" /\ stage' = "idle" /\ attempted' = FALSE
          /\ UNCHANGED <<generation,issued,host,tasks,taskGeneration,cancelled,wire,aborted,
               busy,pending,wakeOwner,revision,sourceRevision,admission,stopped,published,
               cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
Unbusy == /\ busy /\ busy' = FALSE
          /\ UNCHANGED <<stage,generation,issued,host,tasks,taskGeneration,cancelled,wire,
               aborted,pending,wakeOwner,attempted,revision,sourceRevision,admission,stopped,
               published,cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
Seal(i) == /\ tasks[i] = "reading" /\ i \notin aborted /\ i \notin cancelled
           /\ sourceRevision[i] = revision
           /\ tasks' = [tasks EXCEPT ![i] = "sealed"]
           /\ UNCHANGED <<stage,generation,issued,host,taskGeneration,cancelled,wire,aborted,
                busy,pending,wakeOwner,attempted,revision,sourceRevision,admission,stopped,
                published,cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
Append == /\ stage \in {"working","closed"} /\ revision = 0 /\ revision' = 1
          /\ UNCHANGED <<stage,generation,issued,host,tasks,taskGeneration,cancelled,wire,
               aborted,busy,pending,wakeOwner,attempted,sourceRevision,admission,stopped,
               published,cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
CancelArrives(i) == /\ i \in wire /\ wire' = wire \ {i}
                   /\ aborted' = aborted \cup {j \in Ids: tasks[j] \in {"reading","sealed"}
                        /\ ((j=i /\ taskGeneration[j]=taskGeneration[i]) \/ CancelWrongToken)}
                   /\ UNCHANGED <<stage,generation,issued,host,tasks,taskGeneration,cancelled,
                        busy,pending,wakeOwner,attempted,revision,sourceRevision,admission,
                        stopped,published,cacheKey,lostOwner,badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
\* SDK rename may already be queued. A sealed immutable prefix can publish
\* after abort, source mutation, stop or retirement. True is not freshness.
Finish(i) == /\ tasks[i] \in {"scheduled","reading","sealed"}
             /\ tasks' = [tasks EXCEPT ![i] = "done"]
             /\ published' = IF tasks[i] = "sealed" THEN published \cup {i} ELSE published
             /\ cacheKey' = IF tasks[i] = "sealed"
                  THEN IF PerGenerationPath THEN (IF taskGeneration[i]=1 THEN "generation-1" ELSE "generation-2") ELSE "canonical" ELSE cacheKey
             /\ canonicalByPreparation' = (canonicalByPreparation \/ (CanonicalWrite /\ tasks[i]="sealed"))
             /\ host' = IF host=i \/ LateClear THEN 0 ELSE host
             /\ lostOwner' = (lostOwner \/ (LateClear /\ host # 0 /\ host # i))
             /\ UNCHANGED <<stage,generation,issued,taskGeneration,cancelled,wire,aborted,
                  busy,pending,wakeOwner,attempted,revision,sourceRevision,admission,stopped,badDispatch,normalRequests,shutdownRequested,drainedEarly>>
Stop == /\ stage # "closed" /\ stage' = "closed"
        /\ stopped' = ~(AwaitClose /\ Live # {})
        /\ cancelled' = cancelled \cup Live
        /\ wire' = wire \cup {i \in Live: tasks[i] # "scheduled"} /\ host' = 0
        /\ UNCHANGED <<generation,issued,tasks,taskGeneration,aborted,busy,pending,wakeOwner,
             attempted,revision,sourceRevision,admission,published,cacheKey,lostOwner,
             badDispatch,canonicalByPreparation,normalRequests,shutdownRequested,drainedEarly>>
Revive == /\ stage="closed" /\ stopped /\ generation=1 /\ generation'=2
          /\ stage'="idle" /\ wakeOwner'=FALSE /\ pending'=FALSE /\ attempted'=FALSE
          /\ normalRequests'=0 /\ shutdownRequested'=FALSE /\ drainedEarly'=FALSE
          /\ UNCHANGED <<issued,host,tasks,taskGeneration,cancelled,wire,aborted,busy,revision,
               sourceRevision,admission,stopped,published,cacheKey,lostOwner,badDispatch,canonicalByPreparation>>
\* Only optional prepare promises are excluded from ctx.shutdown's pending
\* drain. Normal RPCs keep their existing drain and admission ownership.
NormalRequest == /\ stage # "closed" /\ ~shutdownRequested /\ normalRequests=0
                 /\ normalRequests'=1
                 /\ UNCHANGED <<stage,generation,issued,host,tasks,taskGeneration,cancelled,wire,aborted,
                      busy,pending,wakeOwner,attempted,revision,sourceRevision,admission,stopped,published,
                      cacheKey,lostOwner,badDispatch,canonicalByPreparation,shutdownRequested,drainedEarly>>
FinishNormal == /\ normalRequests=1 /\ normalRequests'=0
                /\ UNCHANGED <<stage,generation,issued,host,tasks,taskGeneration,cancelled,wire,aborted,
                     busy,pending,wakeOwner,attempted,revision,sourceRevision,admission,stopped,published,
                     cacheKey,lostOwner,badDispatch,canonicalByPreparation,shutdownRequested,drainedEarly>>
RequestShutdown == /\ stage # "closed" /\ ~shutdownRequested /\ shutdownRequested'=TRUE
                   /\ cancelled'=cancelled \cup Live
                   /\ wire'=wire \cup {i \in Live: tasks[i] # "scheduled"} /\ host'=0
                   /\ UNCHANGED <<stage,generation,issued,tasks,taskGeneration,aborted,busy,pending,wakeOwner,
                        attempted,revision,sourceRevision,admission,stopped,published,cacheKey,lostOwner,
                        badDispatch,canonicalByPreparation,normalRequests,drainedEarly>>
DrainShutdown == /\ stage = "idle" /\ ~busy /\ shutdownRequested
                 /\ (normalRequests=0 \/ DrainNormalEarly)
                 /\ (~AwaitClose \/ {i \in Live: tasks[i] # "scheduled"} = {})
                 /\ stage'="closed" /\ stopped'=TRUE
                 /\ drainedEarly'=(drainedEarly \/ normalRequests # 0)
                 /\ UNCHANGED <<generation,issued,host,tasks,taskGeneration,cancelled,wire,aborted,busy,pending,
                      wakeOwner,attempted,revision,sourceRevision,admission,published,cacheKey,lostOwner,
                      badDispatch,canonicalByPreparation,normalRequests,shutdownRequested>>
Next == NormalRequest \/ FinishNormal \/ RequestShutdown \/ DrainShutdown \/ Schedule \/ Wake \/ DrainWake \/ StartWork \/ Settle \/ Unbusy \/ Append \/ Stop \/ Revive
        \/ (\E i \in Ids: Dispatch(i) \/ Seal(i) \/ CancelArrives(i) \/ Finish(i))
Spec == Init /\ [][Next]_vars
AdmissionIndependent == wakeOwner => admission
CloseIndependent == stage="closed" => stopped
WakeCancellation == wakeOwner => Live \subseteq cancelled
ExactCancellation == aborted \subseteq cancelled
IdlePreparation == ~badDispatch
StableSourceOwner == published # {} => cacheKey="canonical"
CanonicalUnchanged == ~canonicalByPreparation
SuccessorOwnership == ~lostOwner
CancelledScheduleDoesNotConsume == issued=1 /\ tasks[1]="scheduled" /\ 1 \in cancelled => ~attempted
NormalDrainPreserved == ~drainedEarly
ShutdownPreparationIndependent == shutdownRequested /\ stage="idle" /\ ~busy /\ normalRequests=0 => ENABLED DrainShutdown
IdleRetryAvailable == stage="idle" /\ ~shutdownRequested /\ ~wakeOwner /\ ~pending /\ ~busy /\ ~attempted /\ host=0 /\ issued<2 => ENABLED Schedule
=============================================================================
