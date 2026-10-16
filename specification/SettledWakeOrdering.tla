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
Spec == Init /\ [][Next]_vars
NoStaleReadiness == stopFirst => ~readinessStarted
StoppedDrained == stopDone => actor="stopped" /\ ~owner
RegistrationReleasesMutation == owner => "settled" \notin {queue[i]:i \in 1..Len(queue)}
NoEmptyRevival == ~emptyRestart
NoLostFreshInput == finished /\ ~stopStarted => ~pending
=============================================================================
