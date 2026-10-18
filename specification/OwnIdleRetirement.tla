---------------------- MODULE OwnIdleRetirement ----------------------
EXTENDS Integers, TLC
CONSTANTS ConflateFamily, ResetFamilyAge, IgnoreOwnWork, StaleTimer,
          SkipWake, BlockPreparation, RetireChild
VARIABLES s, projection
vars == <<s, projection>>
OwnIdle == s.stage="resident" /\ ~s.streaming /\ s.quiet>=0
NoOwnWork == ~s.tool /\ ~s.mutation /\ ~s.wake /\ s.pending="none"
Eligible == OwnIdle /\ NoOwnWork
Display == IF s.streaming THEN "working" ELSE IF s.child THEN "delegating" ELSE "idle"
PolicyIdle == OwnIdle /\ (~ConflateFamily \/ Display="idle")
MayRetire == PolicyIdle /\ (NoOwnWork \/ IgnoreOwnWork)
Init == /\ projection="inactive"
        /\ s = [stage |-> "resident", generation |-> 1, now |-> 0, quiet |-> 0,
             streaming |-> FALSE, tool |-> FALSE, mutation |-> FALSE, wake |-> FALSE,
             child |-> TRUE, pending |-> "none", admitted |-> FALSE, delivered |-> FALSE,
             timer |-> 0, timerQuiet |-> -1, prep |-> "none", prepGeneration |-> 0,
             unsafe |-> FALSE, stale |-> FALSE, ageReset |-> FALSE, childLost |-> FALSE]
Tick == /\ s.now<2 /\ s'=[s EXCEPT !.now=@+1]
ChildChange == s'=[s EXCEPT !.child=~@,
                    !.quiet=IF ResetFamilyAge /\ OwnIdle THEN s.now ELSE @,
                    !.ageReset=@ \/ (ResetFamilyAge /\ OwnIdle /\ s.now#s.quiet)]
Start == /\ s.stage="resident" /\ ~s.streaming
         /\ s'=[s EXCEPT !.streaming=TRUE, !.quiet=-1, !.prep="cancelled", !.timer=IF StaleTimer THEN @ ELSE 0]
Settle == /\ s.stage="resident" /\ s.streaming
          /\ s'=[s EXCEPT !.streaming=FALSE, !.quiet=s.now, !.prep="none"]
Tool == /\ s.stage="resident" /\ s'=[s EXCEPT !.tool=~@]
Mutation == /\ s.stage="resident" /\ s'=[s EXCEPT !.mutation=~@]
Admit(kind) == /\ ~s.admitted /\ s'=[s EXCEPT !.pending=kind, !.admitted=TRUE, !.prep="cancelled"]
Wake == /\ ~SkipWake /\ ~s.wake /\ s.stage#"closing"
        /\ s.pending#"none"
        /\ s'=[s EXCEPT !.wake=TRUE, !.prep="cancelled"]
Revive == /\ s.stage="retired" /\ s.wake /\ s.generation=1
          /\ s'=[s EXCEPT !.stage="resident", !.generation=2, !.quiet=s.now, !.prep="none"]
Deliver == /\ s.stage="resident" /\ s.wake /\ s.pending#"none"
           /\ s'=[s EXCEPT !.pending="none", !.delivered=TRUE, !.streaming=TRUE,
                            !.quiet=-1, !.wake=FALSE, !.prep="cancelled",
                            !.timer=IF StaleTimer THEN @ ELSE 0]
DrainWake == /\ s.wake /\ s.pending="none" /\ s'=[s EXCEPT !.wake=FALSE]
Arm == /\ Eligible /\ s.timer=0 /\ s'=[s EXCEPT !.timer=s.generation, !.timerQuiet=s.quiet]
\* Retirement is the callback running under its existing serialized owner;
\* mutation denotes prior own control/admission, not that callback's own lease.
Retire(reason) == /\ MayRetire
                  /\ (reason="capacity" \/ (s.timer#0 /\ s.now-s.timerQuiet>=1 /\ (StaleTimer \/
                      (s.timer=s.generation /\ s.timerQuiet=s.quiet /\ s.now-s.quiet>=1))))
                  /\ s'=[s EXCEPT !.stage="closing", !.prep="cancelled",
                       !.unsafe=@ \/ ~Eligible,
                       !.stale=@ \/ (reason="expiry" /\ (s.timer#s.generation \/ s.timerQuiet#s.quiet \/ s.now-s.quiet<1)),
                       !.child=IF RetireChild THEN FALSE ELSE @,
                       !.childLost=@ \/ (RetireChild /\ s.child)]
FinishClose == /\ s.stage="closing" /\ s'=[s EXCEPT !.stage="retired", !.quiet=-1,
                                           !.timer=IF StaleTimer THEN @ ELSE 0]
SchedulePrep == /\ Eligible /\ ~BlockPreparation /\ s.prep="none"
                /\ s'=[s EXCEPT !.prep="scheduled", !.prepGeneration=s.generation]
DispatchPrep == /\ Eligible /\ s.prep="scheduled" /\ s.prepGeneration=s.generation
                /\ s'=[s EXCEPT !.prep="dispatched"]
FinishPrep == /\ s.prep="dispatched" /\ s'=[s EXCEPT !.prep="done"]
PolicyNext == Tick \/ ChildChange \/ Start \/ Settle \/ Tool \/ Mutation \/ Wake \/ Revive
        \/ Deliver \/ DrainWake \/ Arm \/ FinishClose \/ SchedulePrep \/ DispatchPrep \/ FinishPrep
        \/ (\E kind \in {"input","family"}: Admit(kind))
        \/ (\E reason \in {"capacity","expiry"}: Retire(reason))
Next == PolicyNext /\ UNCHANGED projection
Spec == Init /\ [][Next]_vars
SafeRetirement == ~s.unsafe
StableOwnAge == ~s.ageReset
ChildIndependent == ~s.childLost
CapacityAvailable == Eligible => ENABLED Retire("capacity")
ExpiryAvailable == Eligible /\ s.now-s.quiet>=1 /\ s.timer=s.generation /\ s.timerQuiet=s.quiet => ENABLED Retire("expiry")
NoStaleExpiry == ~s.stale
WakeAvailable == s.pending#"none" /\ ~s.wake /\ s.stage#"closing" => ENABLED Wake
InputConserved == s.admitted => (s.pending#"none" \/ s.delivered)
PreparationAvailable == Eligible /\ s.prep="none" => ENABLED SchedulePrep

\* Local actor-state reads preserve each owner's existing sample and guards.
\* Row pairs are selected boundary changes, not a scheduler cross-product.
ProjectionFault == projection.fault
ProjectionNumber(g) == IF g="1" THEN 1 ELSE 2
ProjectionRow(life, gen, activity, quiet, error) ==
  [lifecycle |-> life, generation |-> gen, activity |-> activity, quiet |-> quiet, error |-> error]
ProjectionMissing == ProjectionRow("missing", "1", "inactive", -1, "")
ProjectionIdle == ProjectionRow("resident", "1", "idle", 0, "")
ProjectionWorking == ProjectionRow("resident", "1", "working", -1, "")
ProjectionCases == {
  <<ProjectionMissing, ProjectionIdle>>,
  <<ProjectionIdle, ProjectionMissing>>,
  <<ProjectionIdle, ProjectionRow("deleted", "1", "inactive", -1, "gone")>>,
  <<ProjectionRow("starting", "1", "inactive", -1, ""), ProjectionIdle>>,
  <<ProjectionRow("starting", "1", "inactive", -1, ""), ProjectionRow("error", "1", "inactive", -1, "startup failed")>>,
  <<ProjectionRow("starting", "1", "inactive", -1, ""), ProjectionRow("error", "1", "inactive", -1, "")>>,
  <<ProjectionRow("starting", "1", "inactive", -1, ""), ProjectionRow("starting", "1", "inactive", -1, "")>>,
  <<ProjectionWorking, ProjectionIdle>>,
  <<ProjectionIdle, ProjectionWorking>>,
  <<ProjectionIdle, ProjectionRow("resident", "2", "idle", 0, "")>>,
  <<ProjectionIdle, ProjectionRow("resident", "1", "delegating", 0, "")>>,
  <<ProjectionIdle, ProjectionRow("resident", "1", "idle", 1, "")>>,
  <<ProjectionRow("passivated", "1", "inactive", -1, ""), ProjectionIdle>>,
  <<ProjectionRow("stopped", "1", "inactive", -1, ""), ProjectionIdle>>}
ProjectionFull(row) ==
  [lifecycle |-> row.lifecycle, actorGeneration |-> ProjectionNumber(row.generation),
   activity |-> row.activity, quietSince |-> row.quiet, lastError |-> row.error]
ProjectionLocal(row) ==
  [lifecycle |-> IF ProjectionFault="deleted" /\ row.lifecycle="deleted" THEN "missing" ELSE row.lifecycle,
   actorGeneration |-> IF ProjectionFault="generation" THEN 1 ELSE ProjectionNumber(row.generation),
   activity |-> row.activity, quietSince |-> row.quiet,
   lastError |-> IF ProjectionFault="error" THEN "" ELSE row.error]
ProjectionEntry(row) == IF row.lifecycle \in {"missing","deleted"} THEN "missing" ELSE "continue"
ProjectionReady(row) == IF row.lifecycle="error" THEN
  IF row.lastError="" THEN "session actor failed to start" ELSE row.lastError ELSE "wait"
ProjectionOwnIdle(row, guard) == guard=0 /\ row.lifecycle="resident"
  /\ row.actorGeneration=1 /\ row.quietSince>=0
ProjectionDeferred(row, captured, guard) ==
  [prepare |-> ProjectionOwnIdle(row, guard),
   retire |-> row.quietSince=captured.quietSince /\ ProjectionOwnIdle(row, guard),
   resetAttempt |-> row.activity="working"]
ProjectionInit(fault) == /\ s="inactive"
  /\ \E pair \in ProjectionCases, running \in BOOLEAN, guard \in 0..8, depth \in 0..2:
    projection=[fault |-> fault, pair |-> pair, running |-> running, guard |-> guard, depth |-> depth,
      step |-> 0, reads |-> 0, expectedReads |-> 0, localSql |-> 0,
      familySql |-> 0, ancestrySql |-> 0, jsonWork |-> 0, bad |-> FALSE,
      sampleBad |-> FALSE, deferredBad |-> FALSE, freshnessBad |-> FALSE,
      returned |-> FALSE]
ProjectionEntryRead == /\ projection.step=0
  /\ LET row == projection.pair[1]
         full == ProjectionFull(row)
         local == ProjectionLocal(row)
     IN projection'=[projection EXCEPT !.step=1,
          !.bad=@ \/ (ProjectionEntry(full)#ProjectionEntry(local)) \/ full#local]
  /\ UNCHANGED s
ProjectionFirstSample == /\ projection.step=1
  /\ LET full == ProjectionFull(projection.pair[1])
         local == ProjectionLocal(projection.pair[1])
         read == IF projection.running THEN 1 ELSE 0
         ready == projection.running /\ full.lifecycle="resident"
     IN projection'=[projection EXCEPT !.step=2, !.reads=@+read, !.expectedReads=@+read,
          !.localSql=@+read,
          !.familySql=@+IF ProjectionFault="full" THEN read ELSE 0,
          !.ancestrySql=@+IF ProjectionFault="full" THEN read*(2*projection.depth+1) ELSE 0,
          !.jsonWork=@+IF ProjectionFault="full" THEN read*2 ELSE 0,
          !.returned=ready,
          !.bad=@ \/ (projection.running /\ (ready#(local.lifecycle="resident")))]
  /\ UNCHANGED s
ProjectionSecondSample == /\ projection.step=2
  /\ LET row == projection.pair[2]
         full == ProjectionFull(row)
         cached == ProjectionFault="cache" \/ (ProjectionFault="merge" /\ projection.running)
         local == ProjectionLocal(IF cached THEN projection.pair[1] ELSE row)
         read == IF projection.returned THEN 0 ELSE 1
         actualRead == IF ProjectionFault="merge" /\ projection.running THEN 0 ELSE read
     IN projection'=[projection EXCEPT !.step=3,
          !.reads=@+actualRead, !.expectedReads=@+read, !.localSql=@+actualRead,
          !.familySql=@+IF ProjectionFault="full" THEN read ELSE 0,
          !.ancestrySql=@+IF ProjectionFault="full" THEN read*(2*projection.depth+1) ELSE 0,
          !.jsonWork=@+IF ProjectionFault="full" THEN read*2 ELSE 0,
          !.sampleBad=@ \/ (actualRead#read),
          !.freshnessBad=@ \/ (read=1 /\ cached /\ projection.pair[1]#row),
          !.bad=@ \/ (read=1 /\ (full#local \/ ProjectionReady(full)#ProjectionReady(local)))]
  /\ UNCHANGED s
ProjectionDeferredSample == /\ projection.step=3
  /\ LET captured == ProjectionFull(projection.pair[1])
         full == ProjectionFull(projection.pair[2])
         local == ProjectionLocal(IF ProjectionFault="deferred" THEN projection.pair[1] ELSE projection.pair[2])
     IN projection'=[projection EXCEPT !.step=4,
          !.deferredBad=@ \/ (ProjectionDeferred(full,captured,projection.guard)#ProjectionDeferred(local,captured,projection.guard)),
          !.freshnessBad=@ \/ (ProjectionFault="deferred" /\ projection.pair[1]#projection.pair[2])]
  /\ UNCHANGED s
ProjectionNext == ProjectionEntryRead \/ ProjectionFirstSample \/ ProjectionSecondSample \/ ProjectionDeferredSample
ProjectionSpec == ProjectionInit("none") /\ [][ProjectionNext]_vars
ProjectionMergeSpec == ProjectionInit("merge") /\ [][ProjectionNext]_vars
ProjectionCacheSpec == ProjectionInit("cache") /\ [][ProjectionNext]_vars
ProjectionDeletedSpec == ProjectionInit("deleted") /\ [][ProjectionNext]_vars
ProjectionGenerationSpec == ProjectionInit("generation") /\ [][ProjectionNext]_vars
ProjectionErrorSpec == ProjectionInit("error") /\ [][ProjectionNext]_vars
ProjectionDeferredSpec == ProjectionInit("deferred") /\ [][ProjectionNext]_vars
ProjectionFullSpec == ProjectionInit("full") /\ [][ProjectionNext]_vars
ProjectionEquivalent == ~projection.bad
ProjectionSampling == ~projection.sampleBad /\ projection.reads=projection.expectedReads
ProjectionFresh == ~projection.freshnessBad
ProjectionDeferredEquivalent == ~projection.deferredBad
ProjectionWork == projection.localSql=projection.reads /\ projection.familySql=0 /\ projection.ancestrySql=0 /\ projection.jsonWork=0
=============================================================================
