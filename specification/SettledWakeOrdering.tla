---------------------- MODULE SettledWakeOrdering ----------------------
EXTENDS Naturals, Sequences, TLC
VARIABLES queue, compactHeld, stopAdmitted, settledAdmitted, stopFirst,
          actor, owner, readinessHeld, readinessStarted, stopDone
vars == <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,
          actor,owner,readinessHeld,readinessStarted,stopDone>>
Init == /\ queue= <<>> /\ compactHeld=TRUE /\ stopAdmitted=FALSE
        /\ settledAdmitted=FALSE /\ stopFirst=FALSE /\ actor="resident"
        /\ owner=FALSE /\ readinessHeld=TRUE /\ readinessStarted=FALSE /\ stopDone=FALSE
Stop == /\ ~stopAdmitted /\ stopAdmitted'=TRUE /\ queue'=Append(queue,"stop")
        /\ UNCHANGED <<compactHeld,settledAdmitted,stopFirst,actor,owner,readinessHeld,readinessStarted,stopDone>>
Settled == /\ ~settledAdmitted /\ settledAdmitted'=TRUE /\ stopFirst'=stopAdmitted
           /\ queue'=Append(queue,"settled")
           /\ UNCHANGED <<compactHeld,stopAdmitted,actor,owner,readinessHeld,readinessStarted,stopDone>>
ReleaseCompact == /\ compactHeld /\ compactHeld'=FALSE
                  /\ UNCHANGED <<queue,stopAdmitted,settledAdmitted,stopFirst,actor,owner,readinessHeld,readinessStarted,stopDone>>
Register == /\ ~compactHeld /\ Len(queue)>0 /\ Head(queue)="settled"
            /\ queue'=Tail(queue) /\ owner'=(actor="resident")
            /\ readinessStarted'=(actor="resident")
            /\ UNCHANGED <<compactHeld,stopAdmitted,settledAdmitted,stopFirst,actor,readinessHeld,stopDone>>
ReleaseReady == /\ readinessHeld /\ readinessHeld'=FALSE
                /\ UNCHANGED <<queue,compactHeld,stopAdmitted,settledAdmitted,stopFirst,actor,owner,readinessStarted,stopDone>>
JoinStop == /\ ~compactHeld /\ Len(queue)>0 /\ Head(queue)="stop"
            /\ (~owner \/ ~readinessHeld)
            /\ queue'=Tail(queue) /\ actor'="stopped" /\ owner'=FALSE /\ stopDone'=TRUE
            /\ UNCHANGED <<compactHeld,stopAdmitted,settledAdmitted,stopFirst,readinessHeld,readinessStarted>>
Next == Stop \/ Settled \/ ReleaseCompact \/ Register \/ ReleaseReady \/ JoinStop
Spec == Init /\ [][Next]_vars
NoStaleReadiness == stopFirst => ~readinessStarted
StoppedDrained == stopDone => actor="stopped" /\ ~owner
RegistrationReleasesMutation == owner => "settled" \notin {queue[i]:i \in 1..Len(queue)}
=============================================================================
