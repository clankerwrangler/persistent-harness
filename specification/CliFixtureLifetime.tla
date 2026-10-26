------------------------- MODULE CliFixtureLifetime -------------------------
EXTENDS Naturals
CONSTANT JoinExit
VARIABLES kind, helper, service, acknowledged, cleanup, removed, lateWrite, recreated
vars == <<kind, helper, service, acknowledged, cleanup, removed, lateWrite, recreated>>
Init == /\ kind \in {"direct", "detached"}
        /\ helper = "running" /\ service = "running" /\ acknowledged = FALSE
        /\ cleanup = "new" /\ removed = FALSE /\ lateWrite = FALSE /\ recreated = FALSE
HelperExit == /\ kind = "detached" /\ helper = "running" /\ helper' = "exited"
              /\ UNCHANGED <<kind, service, acknowledged, cleanup, removed, lateWrite, recreated>>
ShutdownReply == /\ ~acknowledged /\ acknowledged' = TRUE /\ service' = "draining"
                 /\ UNCHANGED <<kind, helper, cleanup, removed, lateWrite, recreated>>
BeginCleanup == /\ acknowledged /\ cleanup = "new" /\ cleanup' = "waiting"
                /\ UNCHANGED <<kind, helper, service, acknowledged, removed, lateWrite, recreated>>
WriteTail == /\ service = "draining" /\ ~lateWrite /\ lateWrite' = TRUE
             /\ recreated' = removed
             /\ UNCHANGED <<kind, helper, service, acknowledged, cleanup, removed>>
ServiceExit == /\ service = "draining" /\ lateWrite /\ service' = "exited"
               /\ helper' = IF kind = "direct" THEN "exited" ELSE helper
               /\ UNCHANGED <<kind, acknowledged, cleanup, removed, lateWrite, recreated>>
Remove == /\ cleanup = "waiting" /\ helper = "exited"
          /\ (~JoinExit \/ service = "exited")
          /\ removed' = TRUE /\ cleanup' = "done"
          /\ UNCHANGED <<kind, helper, service, acknowledged, lateWrite, recreated>>
Next == HelperExit \/ ShutdownReply \/ BeginCleanup \/ WriteTail \/ ServiceExit \/ Remove
Spec == Init /\ [][Next]_vars /\ WF_vars(HelperExit) /\ WF_vars(ShutdownReply)
        /\ WF_vars(BeginCleanup) /\ WF_vars(WriteTail) /\ WF_vars(ServiceExit) /\ WF_vars(Remove)
TypeOK == /\ kind \in {"direct", "detached"} /\ helper \in {"running", "exited"}
          /\ service \in {"running", "draining", "exited"}
          /\ acknowledged \in BOOLEAN /\ cleanup \in {"new", "waiting", "done"}
          /\ removed \in BOOLEAN /\ lateWrite \in BOOLEAN /\ recreated \in BOOLEAN
RemovalAfterExit == removed => service = "exited"
NoLateRecreation == ~recreated
Completes == <> (cleanup = "done")
=============================================================================
