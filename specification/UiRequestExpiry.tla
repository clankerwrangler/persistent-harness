---- MODULE UiRequestExpiry ----
\* Sources:
\*   src/supervisor.mjs sha256:af62c71c62cfa111f3915ce54c2fc2800516856e4fc798b3429c1c5794de555f

\* A dialog's deadline passes before its cleanup timer runs. A response in that
\* gap must be refused, because the actor has already stopped waiting.
EXTENDS Naturals
CONSTANT CheckDeadline
VARIABLES phase, record, delivered, refused

vars == <<phase, record, delivered, refused>>

Init == phase = "open" /\ record = TRUE /\ delivered = FALSE /\ refused = FALSE

DeadlinePasses == phase = "open" /\ phase' = "expired" /\ UNCHANGED <<record, delivered, refused>>
CleanupTimer == phase = "expired" /\ record /\ record' = FALSE /\ UNCHANGED <<phase, delivered, refused>>

Accepted == record /\ ~(CheckDeadline /\ phase = "expired")
Respond == ~delivered /\ ~refused
  /\ IF Accepted THEN delivered' = TRUE /\ record' = FALSE /\ refused' = refused /\ phase' = IF phase = "open" THEN "answered" ELSE phase
     ELSE refused' = TRUE /\ UNCHANGED <<delivered, record, phase>>

Done == UNCHANGED vars
Next == DeadlinePasses \/ CleanupTimer \/ Respond \/ Done
Spec == Init /\ [][Next]_vars

NoLateDelivery == delivered => phase = "answered"
====
