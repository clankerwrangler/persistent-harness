----------------------- MODULE KernelColdResidency -----------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE s
vars == <<s>>
Key == <<s.generation, s.epoch>>
Idle == s.present /\ s.control = "idle" /\ ~s.pending /\ ~s.snapshot /\ ~s.host /\ ~s.closed /\ ~s.native /\ ~s.debounced /\ ~s.observing
Eligible == Idle /\ s.due /\ s.supported
Init == \E capability \in BOOLEAN : s = [present |-> TRUE, generation |-> 1, epoch |-> 1, due |-> FALSE, everDue |-> FALSE,
  timer |-> capability, attempted |-> FALSE, debounced |-> FALSE, observing |-> FALSE, pageCalls |-> 0,
  control |-> "idle", pending |-> FALSE, snapshot |-> FALSE, host |-> FALSE,
  native |-> FALSE, marked |-> FALSE, grace |-> FALSE, referenced |-> FALSE,
  closed |-> FALSE, supported |-> capability, pressure |-> TRUE, swap |-> TRUE, owned |-> TRUE,
  cooling |-> "none", owner |-> <<0,0>>, cancelled |-> FALSE, budget |-> 3,
  resident |-> 2, swapped |-> 0, identity |-> 1, state |-> 42,
  unsafe |-> FALSE, stale |-> FALSE, launched |-> FALSE,
  admissionBlocked |-> FALSE, batches |-> 0]
Request == /\ s.cooling = "none" /\ s.budget > 0 /\ s.timer
           /\ (Eligible \/ Fault="busy" \/ Fault="legacy")
           /\ s' = [s EXCEPT !.cooling="reserved", !.timer=FALSE, !.attempted=TRUE, !.owner=Key, !.cancelled=FALSE,
                 !.unsafe=@ \/ ~Eligible]
Start == /\ s.cooling="reserved"
         /\ ((Eligible /\ ~s.cancelled /\ s.owner=Key) \/ Fault="cancel")
         /\ s'=[s EXCEPT !.cooling="running", !.control=IF Fault="reserve" THEN @ ELSE "cooling",
               !.unsafe=@ \/ ~Eligible \/ s.cancelled \/ s.owner#Key]
Mark == /\ s.cooling="running" /\ s.control="cooling" /\ ~s.marked /\ s.budget>0
        /\ (s.owned \/ Fault="ownership")
        /\ s'=[s EXCEPT !.marked=TRUE, !.referenced=FALSE, !.budget=@-1, !.batches=@+1, !.unsafe=@ \/ ~s.owned]
AgeCold == /\ s.marked /\ ~s.grace /\ s.cooling="yielded"
           /\ s'=[s EXCEPT !.grace=TRUE]
Hot == /\ ~s.referenced /\ (Fault#"latehot" \/ s.pageCalls>0) /\ s'=[s EXCEPT !.referenced=TRUE]
Native == /\ ~s.native /\ s.control="execution" /\ s'=[s EXCEPT !.native=TRUE, !.cancelled=TRUE]
Page == /\ s.cooling="running" /\ s.control="cooling"
        /\ (s.owned \/ Fault="ownership")
        /\ ((s.pressure /\ s.swap /\ s.supported) \/ Fault="unsupported")
        /\ ((s.marked /\ s.grace) \/ Fault="stage")
        /\ (~s.referenced \/ Fault="hot" \/ Fault="latehot")
        /\ (s.budget>0 \/ Fault="budget") /\ (s.resident>0 \/ Fault="budget")
        /\ s'=[s EXCEPT !.resident=IF @>0 THEN @-1 ELSE @, !.swapped=IF s.resident>0 THEN @+1 ELSE @, !.budget=IF @>0 THEN @-1 ELSE 0,
              !.batches=@+1, !.pageCalls=@+1, !.unsafe=@ \/ ~(s.pressure /\ s.swap /\ s.supported /\ s.marked /\ s.grace /\ ~s.referenced /\ s.owned),
              !.state=IF Fault="state" THEN 0 ELSE @]
Finish == /\ s.cooling="running"
          /\ s'=[s EXCEPT !.cooling=IF s.closed THEN "none" ELSE "yielded",
                !.control=IF @="cooling" THEN "idle" ELSE @,
                !.timer=(Fault#"rearm" /\ s.present /\ ~s.closed /\ ~s.pending /\ ~s.snapshot
                    /\ ~s.host /\ ~s.native /\ ~s.debounced /\ ~s.observing),
                !.stale=@ \/ (Fault="late" /\ s.owner[1]#s.generation)]
Continue == /\ s.cooling="yielded" /\ Eligible /\ s.timer /\ s.owner[1]=s.generation /\ s.budget>0
            /\ s'=[s EXCEPT !.cooling="reserved", !.owner=Key, !.cancelled=FALSE, !.timer=FALSE]
Skip == /\ s.cooling \in {"reserved","yielded"}
        /\ (~Eligible \/ s.cancelled \/ s.owner#Key \/ s.budget=0)
        /\ s'=[s EXCEPT !.cooling=IF s.closed \/ ~s.supported \/ s.budget=0 THEN "none" ELSE "yielded",
                         !.timer=Idle /\ s.supported]
\* Wake here is queued kernel execution demand, not actor/model activity.
Wake == /\ ~s.pending /\ ~s.closed /\ s.epoch=1
        /\ s'=[s EXCEPT !.pending=TRUE, !.due=IF Fault="starve" THEN FALSE ELSE @, !.cancelled=TRUE, !.epoch=2, !.attempted=FALSE, !.timer=FALSE,
              !.admissionBlocked=Fault="await" /\ s.cooling#"none"]
Execute == /\ s.pending /\ s.control="idle"
           /\ (s.cooling#"reserved" \/ Fault="reserve")
           /\ s'=[s EXCEPT !.pending=FALSE, !.control="execution",
                 !.unsafe=@ \/ s.cooling="running"]
Use == /\ s.control="execution"
       /\ s'=[s EXCEPT !.resident=@+s.swapped, !.swapped=0, !.control="idle", !.native=FALSE, !.due=IF Fault="starve" THEN FALSE ELSE @, !.attempted=FALSE,
             !.timer=~s.snapshot /\ ~s.host /\ ~s.debounced /\ ~s.observing /\ ~s.closed]
Snapshot == /\ ~s.snapshot /\ s'=[s EXCEPT !.epoch=2, !.snapshot=TRUE, !.debounced=FALSE, !.timer=FALSE, !.cancelled=TRUE]
SnapshotDone == /\ s.snapshot /\ s.control#"cooling"
                /\ s'=[s EXCEPT !.snapshot=FALSE, !.timer=~s.pending /\ ~s.host /\ ~s.native /\ ~s.observing /\ ~s.closed]
Scheduled == /\ ~s.debounced /\ s'=[s EXCEPT !.debounced=TRUE, !.cancelled=TRUE, !.timer=FALSE]
Observe == /\ Idle /\ s.cooling \notin {"reserved","running"} /\ ~s.observing /\ s'=[s EXCEPT !.observing=TRUE]
ObserveDone == /\ s.observing /\ s'=[s EXCEPT !.observing=FALSE,
                    !.timer=Fault#"diagrearm" /\ ~s.pending /\ ~s.snapshot /\ ~s.host /\ ~s.native /\ ~s.debounced /\ ~s.closed]
TimerMiss == /\ s.timer /\ s.due /\ ~Eligible /\ s'=[s EXCEPT !.timer=FALSE]
Host == /\ ~s.host /\ s'=[s EXCEPT !.host=TRUE, !.cancelled=TRUE]
Unavailable == /\ s.supported /\ s'=[s EXCEPT !.supported=FALSE, !.cancelled=TRUE]
NoSwap == /\ s.swap /\ s'=[s EXCEPT !.swap=FALSE]
Relief == /\ s.pressure /\ s'=[s EXCEPT !.pressure=FALSE]
Close == /\ ~s.closed /\ s'=[s EXCEPT !.closed=TRUE, !.cancelled=TRUE]
Replace == /\ s.closed /\ (s.cooling#"running" \/ Fault="late") /\ s.generation=1
           /\ s'=[s EXCEPT !.generation=2, !.present=FALSE, !.closed=FALSE,
                 !.launched=Fault="launch"]
Tick == /\ ~s.due /\ s'=[s EXCEPT !.due=TRUE, !.everDue=TRUE]
Remap == /\ s.owned /\ s'=[s EXCEPT !.owned=FALSE]
Next == Remap \/ Tick \/ Scheduled \/ SnapshotDone \/ Observe \/ ObserveDone \/ TimerMiss \/ Request \/ Start \/ Mark \/ AgeCold \/ Hot \/ Native \/ Page \/ Finish \/ Continue \/ Skip \/ Wake \/ Execute \/ Use
        \/ Snapshot \/ Host \/ Unavailable \/ NoSwap \/ Relief \/ Close \/ Replace
Spec == Init /\ [][Next]_vars
Guarded == ~s.unsafe
StateAndIdentity == s.state=42 /\ s.identity=1 /\ s.resident+s.swapped=2
AdmissionIndependent == ~s.admissionBlocked
NoStartup == ~s.launched
BoundedWork == s.batches<=3
Fifo == s.cooling="running" => s.control="cooling"
TimerCoverage == (Idle /\ s.supported /\ ((s.cooling="none" /\ ~s.attempted) \/ (s.cooling="yielded" /\ s.budget>0))) => s.timer
CadenceSurvivesCells == s.everDue /\ s.budget>0 => s.due
GenerationOwned == ~s.stale
=============================================================================
