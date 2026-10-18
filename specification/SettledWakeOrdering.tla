---------------------- MODULE SettledWakeOrdering ----------------------
EXTENDS Naturals, Sequences, TLC
CONSTANTS FenceExitedWake, PreserveFreshInput, BadStopSkipsOwner
VARIABLES queue, compactHeld, stopAdmitted, settledAdmitted, stopFirst,
          actor, owner, readinessHeld, readinessStarted, stopDone,
          crashed, pending, delivered, explicitIntent, finished, emptyRestart, stopStarted, wakeCancelled
vars == <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,
          actor,owner,readinessHeld,readinessStarted,stopDone,
          crashed,pending,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
Init == /\ queue= <<>> /\ compactHeld=TRUE /\ stopAdmitted=FALSE
        /\ settledAdmitted=FALSE /\ stopFirst=FALSE /\ actor="resident"
        /\ owner=FALSE /\ readinessHeld=TRUE /\ readinessStarted=FALSE /\ stopDone=FALSE
        /\ crashed=FALSE /\ pending=FALSE /\ delivered=FALSE
        /\ explicitIntent=FALSE /\ finished=FALSE /\ emptyRestart=FALSE
        /\ stopStarted=FALSE /\ wakeCancelled=FALSE
Stop == /\ ~stopAdmitted /\ stopAdmitted'=TRUE /\ queue'=Append(queue,"stop")
        /\ UNCHANGED <<compactHeld,settledAdmitted,stopFirst,actor,owner,readinessHeld,readinessStarted,stopDone,
                       crashed,pending,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
Settled == /\ ~settledAdmitted /\ settledAdmitted'=TRUE /\ stopFirst'=stopAdmitted
           /\ queue'=Append(queue,"settled")
           /\ UNCHANGED <<compactHeld,stopAdmitted,actor,owner,readinessHeld,readinessStarted,stopDone,
                          crashed,pending,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
ReleaseCompact == /\ compactHeld /\ compactHeld'=FALSE
                  /\ UNCHANGED <<queue,stopAdmitted,settledAdmitted,stopFirst,actor,owner,readinessHeld,readinessStarted,stopDone,
                                 crashed,pending,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
Register == /\ ~compactHeld /\ Len(queue)>0 /\ Head(queue)="settled"
            /\ queue'=Tail(queue) /\ owner'=(actor="resident")
            /\ readinessStarted'=(actor="resident")
            /\ UNCHANGED <<compactHeld,stopAdmitted,settledAdmitted,stopFirst,actor,readinessHeld,stopDone,
                           crashed,pending,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
ReleaseReady == /\ readinessHeld /\ readinessHeld'=FALSE
                /\ UNCHANGED <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,actor,owner,readinessStarted,stopDone,
                               crashed,pending,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
CrashDuringReadiness == /\ owner /\ readinessHeld /\ ~crashed /\ actor="resident"
                       /\ actor'="error" /\ crashed'=TRUE
                       /\ UNCHANGED <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,owner,
                                      readinessHeld,readinessStarted,stopDone,pending,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
FreshArrival == /\ owner /\ ~finished /\ ~pending /\ ~stopAdmitted
                /\ pending'=TRUE
                /\ UNCHANGED <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,actor,owner,
                               readinessHeld,readinessStarted,stopDone,crashed,delivered,explicitIntent,finished,emptyRestart,stopStarted,wakeCancelled>>
ExplicitRevival == /\ owner /\ ~finished /\ ~explicitIntent /\ ~stopAdmitted
                   /\ explicitIntent'=TRUE
                   /\ UNCHANGED <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,actor,owner,
                                  readinessHeld,readinessStarted,stopDone,crashed,pending,delivered,finished,emptyRestart,stopStarted,wakeCancelled>>
FinishReadiness == LET allowed == ~wakeCancelled /\ (actor="resident" \/ pending \/ explicitIntent \/ ~FenceExitedWake)
                  IN /\ owner /\ ~readinessHeld
                     /\ actor'=IF allowed THEN "resident" ELSE actor
                     /\ emptyRestart'=(actor="error" /\ ~pending /\ ~explicitIntent /\ allowed)
                     /\ delivered'=(pending /\ allowed /\ PreserveFreshInput)
                     /\ pending'=(pending /\ ~(allowed /\ PreserveFreshInput))
                     /\ owner'=FALSE /\ finished'=TRUE
                     /\ UNCHANGED <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,
                                    readinessHeld,readinessStarted,stopDone,crashed,explicitIntent,stopStarted,wakeCancelled>>
JoinStop == /\ ~compactHeld /\ Len(queue)>0 /\ Head(queue)="stop"
            /\ queue'=Tail(queue) /\ actor'="stopped" /\ stopStarted'=TRUE
            /\ wakeCancelled'=~BadStopSkipsOwner
            /\ UNCHANGED <<compactHeld,stopAdmitted,settledAdmitted,stopFirst,readinessHeld,readinessStarted,
                           crashed,pending,delivered,explicitIntent,finished,emptyRestart,owner,stopDone>>
AcknowledgeStop == /\ stopStarted /\ ~stopDone /\ (~owner \/ BadStopSkipsOwner)
                   /\ stopDone'=TRUE
                   /\ UNCHANGED <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,actor,owner,
                       readinessHeld,readinessStarted,crashed,pending,delivered,explicitIntent,finished,
                       emptyRestart,stopStarted,wakeCancelled>>
Next == Stop \/ Settled \/ ReleaseCompact \/ Register \/ ReleaseReady \/ JoinStop
        \/ CrashDuringReadiness \/ FreshArrival \/ ExplicitRevival \/ FinishReadiness \/ AcknowledgeStop
NoStaleReadiness == stopFirst => ~readinessStarted
StoppedDrained == stopDone => actor="stopped" /\ ~owner
RegistrationReleasesMutation == owner => "settled" \notin {queue[i]:i \in 1..Len(queue)}
NoEmptyRevival == ~emptyRestart
NoLostFreshInput == finished /\ ~stopStarted => ~pending

\* Independent activation owners: two serialized reads and an older launch.
\* Grant publication remains owned even after its asynchronous write starts.
CONSTANTS ReadyHeadOnly, RetryRenewsAuthority, SkipGrantJoin, SkipLaunchFence, LeakRetirementFence
VARIABLES phase, cancelled, released, retiring, acknowledged, deleted, mode,
          liveActor, staleStart, latePublication, renewed, fence, failed,
          freshAccepted, laterActivated, refreshed
activationVars == <<phase,cancelled,released,retiring,acknowledged,deleted,mode,
                    liveActor,staleStart,latePublication,renewed,fence,failed,
                    freshAccepted,laterActivated,refreshed>>
Ids == 1..3
ActivationInit == /\ phase=[i \in Ids |-> IF i=1 THEN "grant" ELSE IF i=2 THEN "queued" ELSE "identity"]
                  /\ cancelled={} /\ released={} /\ retiring=FALSE /\ acknowledged=FALSE
                  /\ deleted=FALSE /\ mode \in {"stop","delete"} /\ liveActor=TRUE
                  /\ staleStart=FALSE /\ latePublication=FALSE /\ renewed=FALSE
                  /\ fence=FALSE /\ failed=FALSE /\ freshAccepted=FALSE
                  /\ laterActivated=FALSE /\ refreshed=FALSE
ReleaseActivation(i) == /\ i \notin released /\ released'=released \cup {i}
                        /\ UNCHANGED <<phase,cancelled,retiring,acknowledged,deleted,mode,liveActor,
                           staleStart,latePublication,renewed,fence,failed,freshAccepted,laterActivated,refreshed>>
BeginRetirement == /\ ~retiring
                   /\ retiring'=TRUE /\ fence'=TRUE /\ liveActor'=FALSE
                   /\ cancelled'=IF ReadyHeadOnly THEN {1} ELSE Ids
                   /\ UNCHANGED <<phase,released,acknowledged,deleted,mode,staleStart,latePublication,
                        renewed,failed,freshAccepted,laterActivated,refreshed>>
RetryReady == /\ phase[2]="queued" /\ phase[1]="done" /\ 2 \in released
              /\ phase'=[phase EXCEPT ![2]=IF 2 \in cancelled /\ ~RetryRenewsAuthority THEN "done" ELSE "grant"]
              /\ renewed'=(renewed \/ (2 \in cancelled /\ RetryRenewsAuthority))
              /\ UNCHANGED <<cancelled,released,retiring,acknowledged,deleted,mode,liveActor,staleStart,
                   latePublication,fence,failed,freshAccepted,laterActivated,refreshed>>
GrantRead(i) == /\ phase[i]="grant" /\ i \in released
                /\ phase'=[phase EXCEPT ![i]=IF i \in cancelled THEN "done" ELSE "write"]
                /\ UNCHANGED <<cancelled,released,retiring,acknowledged,deleted,mode,liveActor,staleStart,
                     latePublication,renewed,fence,failed,freshAccepted,laterActivated,refreshed>>
PublishGrant(i) == /\ phase[i]="write"
                   /\ phase'=[phase EXCEPT ![i]=IF i \in cancelled THEN "done" ELSE "identity"]
                   /\ latePublication'=(latePublication \/ acknowledged)
                   /\ UNCHANGED <<cancelled,released,retiring,acknowledged,deleted,mode,liveActor,
                        staleStart,renewed,fence,failed,freshAccepted,laterActivated,refreshed>>
FinishLaunch(i) == LET permitted == i \notin cancelled \/ SkipLaunchFence
                   IN /\ phase[i]="identity" /\ i \in released
                      /\ phase'=[phase EXCEPT ![i]="done"]
                      /\ liveActor'=(liveActor \/ permitted)
                      /\ staleStart'=(staleStart \/ (retiring /\ permitted))
                      /\ UNCHANGED <<cancelled,released,retiring,acknowledged,deleted,mode,
                           latePublication,renewed,fence,failed,freshAccepted,laterActivated,refreshed>>
Tracked == IF ReadyHeadOnly THEN {1} ELSE Ids
DrainComplete == \A i \in Tracked : phase[i]="done" \/ (SkipGrantJoin /\ phase[i]="write")
AcknowledgeRetirement == /\ retiring /\ ~acknowledged /\ ~failed /\ DrainComplete
                         /\ acknowledged'=TRUE /\ deleted'=(mode="delete")
                         /\ fence'=LeakRetirementFence
                         /\ UNCHANGED <<phase,cancelled,released,retiring,mode,liveActor,staleStart,
                              latePublication,renewed,failed,freshAccepted,laterActivated,refreshed>>
FailRetirement == /\ retiring /\ ~acknowledged /\ ~failed /\ DrainComplete
                  /\ failed'=TRUE /\ fence'=LeakRetirementFence
                  /\ UNCHANGED <<phase,cancelled,released,retiring,acknowledged,deleted,mode,liveActor,
                       staleStart,latePublication,renewed,freshAccepted,laterActivated,refreshed>>
AcceptFresh == /\ ~retiring /\ ~freshAccepted /\ freshAccepted'=TRUE
               /\ UNCHANGED <<phase,cancelled,released,retiring,acknowledged,deleted,mode,liveActor,
                    staleStart,latePublication,renewed,fence,failed,laterActivated,refreshed>>
LaterActivation == /\ (acknowledged \/ failed) /\ ~fence /\ ~deleted /\ ~laterActivated
                   /\ liveActor'=TRUE /\ laterActivated'=TRUE
                   /\ UNCHANGED <<phase,cancelled,released,retiring,acknowledged,deleted,mode,staleStart,
                        latePublication,renewed,fence,failed,freshAccepted,refreshed>>
ResidentRefresh == /\ ~retiring /\ ~refreshed /\ phase[1]="identity" /\ 1 \in released
                   /\ refreshed'=TRUE /\ liveActor'=FALSE
                   /\ UNCHANGED <<phase,cancelled,released,retiring,acknowledged,deleted,mode,
                        staleStart,latePublication,renewed,fence,failed,freshAccepted,laterActivated>>
ActivationNext == BeginRetirement \/ RetryReady \/ AcknowledgeRetirement \/ FailRetirement
                  \/ AcceptFresh \/ LaterActivation \/ ResidentRefresh
                  \/ (\E i \in Ids : ReleaseActivation(i) \/ GrantRead(i) \/ PublishGrant(i) \/ FinishLaunch(i))
Spec == Init /\ ActivationInit /\ mode="stop" /\ [][Next /\ UNCHANGED activationVars]_<<vars,activationVars>>
ActivationSpec == Init /\ ActivationInit /\ [][ActivationNext /\ UNCHANGED vars]_<<vars,activationVars>>
AllOwnersDrained == acknowledged => \A i \in Ids : phase[i]="done"
NoOldStart == ~staleStart
NoLatePublication == ~latePublication
StableCancellation == ~renewed
RetirementReleased == (acknowledged \/ failed) => ~fence
LaterActivationAvailable == (acknowledged \/ failed) /\ ~deleted /\ ~laterActivated => ENABLED LaterActivation
RefreshDoesNotRetire == refreshed /\ ~retiring => ~fence
FreshAdmissionAvailable == ~retiring /\ ~freshAccepted => ENABLED AcceptFresh

=============================================================================
