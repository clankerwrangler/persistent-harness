------------------------- MODULE FixtureActorClose -------------------------
\* Sources:
\*   test/fixtures/notification-supervisor.mjs sha256:52e314c9f65c4f1ed12d8b663968131a77b34f0d829bdc18b7485503981f5d6b
\*   src/supervisor.mjs sha256:8205605adf9af30fc23b9ddc0bb8b52fe865c761830b183f5d6e0e5f62923327

EXTENDS Naturals, TLC
CONSTANT JoinClose
VARIABLES running, tracked, lifecycle, stopPhase, cleanupPhase, exited
vars == <<running, tracked, lifecycle, stopPhase, cleanupPhase, exited>>
Init == /\ running = TRUE /\ tracked = TRUE /\ lifecycle = "resident"
        /\ stopPhase = "new" /\ cleanupPhase = "new" /\ exited = FALSE
BeginStop == /\ stopPhase = "new" /\ stopPhase' = "waiting" /\ running' = FALSE
             /\ UNCHANGED <<tracked, lifecycle, cleanupPhase, exited>>
CleanupClose == /\ stopPhase = "waiting" /\ cleanupPhase = "new"
                /\ cleanupPhase' = IF JoinClose THEN "waiting" ELSE "returned"
                /\ UNCHANGED <<running, tracked, lifecycle, stopPhase, exited>>
ForgetRecord == /\ cleanupPhase = "returned" /\ ~running /\ tracked
                /\ tracked' = FALSE
                /\ UNCHANGED <<running, lifecycle, stopPhase, cleanupPhase, exited>>
Exit == /\ stopPhase = "waiting" /\ ~exited /\ exited' = TRUE
        /\ lifecycle' = IF tracked THEN "stopped" ELSE lifecycle
        /\ tracked' = FALSE
        /\ UNCHANGED <<running, stopPhase, cleanupPhase>>
ReturnCleanup == /\ cleanupPhase = "waiting" /\ exited /\ cleanupPhase' = "returned"
                 /\ UNCHANGED <<running, tracked, lifecycle, stopPhase, exited>>
ReturnStop == /\ stopPhase = "waiting" /\ exited /\ stopPhase' = "returned"
              /\ UNCHANGED <<running, tracked, lifecycle, cleanupPhase, exited>>
Next == BeginStop \/ CleanupClose \/ ForgetRecord \/ Exit \/ ReturnCleanup \/ ReturnStop
Spec == Init /\ [][Next]_vars
TypeOK == /\ running \in BOOLEAN /\ tracked \in BOOLEAN /\ exited \in BOOLEAN
          /\ lifecycle \in {"resident", "stopped"}
          /\ stopPhase \in {"new", "waiting", "returned"}
          /\ cleanupPhase \in {"new", "waiting", "returned"}
ExitOwnsRetirement == ~tracked => lifecycle = "stopped"
StopIsDurable == stopPhase = "returned" => lifecycle = "stopped"
=============================================================================
