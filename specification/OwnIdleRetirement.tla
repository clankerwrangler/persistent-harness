---------------------- MODULE OwnIdleRetirement ----------------------
EXTENDS Integers, TLC
CONSTANTS ConflateFamily, ResetFamilyAge, IgnoreOwnWork, StaleTimer,
          SkipWake, BlockPreparation, RetireChild
VARIABLE s
vars == <<s>>
OwnIdle == s.stage="resident" /\ ~s.streaming /\ s.quiet>=0
NoOwnWork == ~s.tool /\ ~s.mutation /\ ~s.wake /\ s.pending="none"
Eligible == OwnIdle /\ NoOwnWork
Display == IF s.streaming THEN "working" ELSE IF s.child THEN "delegating" ELSE "idle"
PolicyIdle == OwnIdle /\ (~ConflateFamily \/ Display="idle")
MayRetire == PolicyIdle /\ (NoOwnWork \/ IgnoreOwnWork)
Init == s = [stage |-> "resident", generation |-> 1, now |-> 0, quiet |-> 0,
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
Next == Tick \/ ChildChange \/ Start \/ Settle \/ Tool \/ Mutation \/ Wake \/ Revive
        \/ Deliver \/ DrainWake \/ Arm \/ FinishClose \/ SchedulePrep \/ DispatchPrep \/ FinishPrep
        \/ (\E kind \in {"input","family"}: Admit(kind))
        \/ (\E reason \in {"capacity","expiry"}: Retire(reason))
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
=============================================================================
