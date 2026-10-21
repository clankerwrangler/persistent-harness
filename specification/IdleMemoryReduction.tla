-------------------- MODULE IdleMemoryReduction --------------------
EXTENDS Integers, FiniteSets, TLC
CONSTANTS Fault, Expiry
VARIABLE s
vars == <<s>>
Ids == {1,2}
Key == <<s.generation,s.epoch>>
HostIdle == s.stage="resident" /\ ~s.work /\ ~s.wake /\ ~s.mutation /\ ~s.pending
WorkerIdle == s.stage="resident" /\ ~s.workerBusy /\ ~s.pending /\ ~s.prep
Due == s.since>=0 /\ s.now-s.since>=2
Live == {i \in Ids: s.tasks[i] \in {"queued","running"}}
Init == s = [stage |-> "resident", generation |-> 1, epoch |-> 1, quiet |-> 0,
  now |-> 0, since |-> 0, expiry |-> Expiry, deadline |-> Expiry,
  work |-> FALSE, wake |-> FALSE, mutation |-> FALSE, pending |-> FALSE,
  workerBusy |-> FALSE, prep |-> FALSE, gap |-> TRUE, available |-> TRUE,
  attempted |-> {}, issued |-> 0, owner |-> 0, admission |-> FALSE, delivered |-> FALSE,
  tasks |-> [i \in Ids |-> "none"], keys |-> [i \in Ids |-> <<0,0>>], cancelled |-> {},
  unsafeDispatch |-> FALSE, unsafeGC |-> FALSE, repeat |-> FALSE, lostOwner |-> FALSE,
  blockedAdmission |-> FALSE, blockedClose |-> FALSE, disabledExpiry |-> FALSE]
Tick ==
  /\ s.now<6 /\ s'=[s EXCEPT !.now=@+1]
ResetAge ==
  /\ HostIdle /\ s.since=-1 /\ s'=[s EXCEPT !.since=s.now]
Dispatch ==
  /\ HostIdle /\ (Due \/ Fault="early") /\ ~s.prep
  /\ (s.expiry=0 \/ s.now<s.deadline)
  /\ (Key \notin s.attempted \/ Fault="repeat") /\ s.issued<2
  /\ s'=[s EXCEPT !.issued=@+1, !.owner=s.issued+1,
      !.tasks[s.issued+1]="queued", !.keys[s.issued+1]=Key,
      !.attempted=@ \cup {Key}, !.repeat=@ \/ Key \in s.attempted,
      !.unsafeDispatch=@ \/ ~Due,
      !.deadline=IF Fault="retime" THEN s.now+s.expiry+1 ELSE @]
StartGC(i) ==
  /\ s.tasks[i]="queued" /\ i \notin s.cancelled
  /\ s.keys[i]=Key /\ s.gap /\ s.available
  /\ (WorkerIdle \/ Fault="worker")
  /\ s'=[s EXCEPT !.tasks[i]="running", !.unsafeGC=@ \/ ~WorkerIdle]
Skip(i) ==
  /\ s.tasks[i]="queued"
  /\ (i \in s.cancelled \/ s.keys[i]#Key \/ ~WorkerIdle \/ ~s.gap \/ ~s.available)
  /\ s'=[s EXCEPT !.tasks[i]="done",
      !.owner=IF s.owner=i THEN 0 ELSE @]
Finish(i) ==
  /\ s.tasks[i]="running"
  /\ s'=[s EXCEPT !.tasks[i]="done",
      !.owner=IF s.owner=i \/ Fault="late" THEN 0 ELSE @,
      !.lostOwner=@ \/ (Fault="late" /\ s.owner#0 /\ s.owner#i)]
\* Cancellation retires queued work, never joins a running V8 collection.
Wake ==
  /\ s.stage="resident" /\ ~s.wake /\ ~s.pending
  /\ s'=[s EXCEPT !.wake=TRUE, !.pending=TRUE, !.since=-1, !.owner=0,
      !.cancelled=@ \cup Live,
      !.admission=~(Fault="await" /\ Live#{}),
      !.blockedAdmission=@ \/ (Fault="await" /\ Live#{})]
Deliver ==
  /\ s.stage="resident" /\ s.wake /\ s.pending
  /\ s'=[s EXCEPT !.pending=FALSE, !.wake=FALSE, !.delivered=TRUE,
      !.work=TRUE, !.workerBusy=TRUE, !.since=-1]
Settle ==
  /\ s.work /\ s.epoch=1 /\ s.now<=2
  /\ s'=[s EXCEPT !.work=FALSE, !.workerBusy=FALSE, !.epoch=2,
      !.quiet=s.now, !.since=s.now, !.deadline=s.now+s.expiry]
Mutation ==
  /\ s.stage="resident" /\ ~s.mutation
  /\ s'=[s EXCEPT !.mutation=TRUE, !.since=-1, !.owner=0,
      !.cancelled=@ \cup Live]
EndMutation ==
  /\ s.mutation /\ s'=[s EXCEPT !.mutation=FALSE]
WorkerChange ==
  /\ s.stage="resident" /\ s'=[s EXCEPT !.workerBusy=~@]
Preparation ==
  /\ s.stage="resident" /\ s'=[s EXCEPT !.prep=~@]
GapChange == s'=[s EXCEPT !.gap=~@]
Unavailable ==
  /\ s.available /\ s'=[s EXCEPT !.available=FALSE]
Retire(forExpiry) ==
  /\ s.stage="resident"
  /\ s'=[s EXCEPT !.stage="retired", !.owner=0, !.since=-1,
      !.cancelled=@ \cup Live,
      !.blockedClose=@ \/ (Fault="await" /\ Live#{}),
      !.disabledExpiry=@ \/ (forExpiry /\ s.expiry=0)]
Stop == Retire(FALSE)
Expire ==
  /\ (s.expiry>0 \/ Fault="disabled") /\ HostIdle /\ s.now>=s.deadline /\ Retire(TRUE)
Revive ==
  /\ s.stage="retired" /\ s.generation=1
  /\ s'=[s EXCEPT !.stage="resident", !.generation=2, !.epoch=1,
      !.quiet=s.now, !.deadline=s.now+s.expiry, !.since=s.now,
      !.wake=s.pending, !.work=FALSE, !.mutation=FALSE,
      !.workerBusy=FALSE, !.prep=FALSE]
Next == Tick \/ ResetAge \/ Dispatch \/ Wake \/ Deliver \/ Settle \/ Mutation
  \/ EndMutation \/ WorkerChange \/ Preparation \/ GapChange \/ Unavailable
  \/ Stop \/ Expire \/ Revive \/ (\E i \in Ids: StartGC(i) \/ Skip(i) \/ Finish(i))
Spec == Init /\ [][Next]_vars
GraceHonored == ~s.unsafeDispatch
WorkerGuard == ~s.unsafeGC
OncePerQuiet == ~s.repeat
AdmissionIndependent == ~s.blockedAdmission
CloseIndependent == ~s.blockedClose
SuccessorOwned == ~s.lostOwner
PassivationUnchanged == s.deadline=s.quiet+s.expiry
InputConserved == s.pending \/ s.delivered \/ ~s.admission
ExpiryAvailable == s.expiry>0 /\ HostIdle /\ s.now>=s.deadline => ENABLED Expire
DisabledPassivation == ~s.disabledExpiry
=============================================================================
