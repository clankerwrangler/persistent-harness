-------------------- MODULE NotificationDelivery --------------------
EXTENDS Naturals
CONSTANT Intent
VARIABLES run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared
vars == <<run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
Init == /\ run = "pending" /\ outcome = "none" /\ record = FALSE /\ valid = TRUE
        /\ read = FALSE /\ resolved = FALSE /\ attempt = 0 /\ delivery = "pending"
        /\ shown = FALSE /\ deviceRead = FALSE /\ deviceOnline = TRUE /\ rootBusy = TRUE /\ childBusy = FALSE /\ declared = FALSE
Execute == /\ run = "pending" /\ (declared \/ (~rootBusy /\ ~childBusy)) /\ run' = "finished"
           /\ outcome' \in (IF declared THEN {"result", "no_finding"} ELSE {"result", "failed", "missing"})
           /\ UNCHANGED <<record, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
ShouldNotify == Intent = "result" \/ (Intent = "conditional" /\ outcome # "no_finding")
Reconcile == /\ run = "finished" /\ ~record /\ ShouldNotify /\ record' = TRUE
             /\ UNCHANGED <<run, outcome, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
Send == /\ record /\ valid /\ ~read /\ ~resolved /\ delivery = "pending" /\ attempt < 2
        /\ attempt' = attempt + 1 /\ delivery' = "inflight"
        /\ UNCHANGED <<run, outcome, record, valid, read, resolved, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
Receipt == /\ delivery = "inflight" /\ delivery' \in {"accepted", "pending", "failed"}
           /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
\* A process crash may lose provider acceptance; identity stays stable on retry.
Restart == /\ delivery = "inflight" /\ delivery' = "pending"
           /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
MarkRead == /\ record /\ read' = TRUE
            /\ UNCHANGED <<run, outcome, record, valid, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
Resolve == /\ record /\ resolved' = TRUE
           /\ UNCHANGED <<run, outcome, record, valid, read, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
Expire == /\ valid /\ valid' = FALSE
          /\ UNCHANGED <<run, outcome, record, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
Sync == /\ deviceOnline /\ deviceRead' = (read \/ resolved)
        /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceOnline, rootBusy, childBusy, declared>>
Connection == /\ deviceOnline' = ~deviceOnline
              /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceRead, rootBusy, childBusy, declared>>
Display == /\ delivery = "accepted" /\ valid /\ ~deviceRead /\ ~shown
           /\ (~deviceOnline \/ (~read /\ ~resolved)) /\ shown' = TRUE
           /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, delivery, deviceRead, deviceOnline, rootBusy, childBusy, declared>>
Delegate == /\ run = "pending" /\ rootBusy /\ childBusy' = TRUE
            /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, declared>>
RootSettle == /\ rootBusy /\ rootBusy' = FALSE
              /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, childBusy, declared>>
ChildSettle == /\ childBusy /\ childBusy' = FALSE
               /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, declared>>
DeclareReady == /\ run = "pending" /\ declared' = TRUE
                /\ UNCHANGED <<run, outcome, record, valid, read, resolved, attempt, delivery, shown, deviceRead, deviceOnline, rootBusy, childBusy>>
Next == Delegate \/ RootSettle \/ ChildSettle \/ DeclareReady \/ Execute \/ Reconcile \/ Send \/ Receipt \/ Restart \/ MarkRead \/ Resolve \/ Expire \/ Sync \/ Connection \/ Display
TypeOK == /\ rootBusy \in BOOLEAN /\ childBusy \in BOOLEAN /\ declared \in BOOLEAN /\ run \in {"pending", "finished"} /\ outcome \in {"none", "result", "no_finding", "failed", "missing"}
          /\ record \in BOOLEAN /\ valid \in BOOLEAN /\ read \in BOOLEAN /\ resolved \in BOOLEAN
          /\ attempt \in 0..2 /\ delivery \in {"pending", "inflight", "accepted", "failed"}
          /\ shown \in BOOLEAN /\ deviceRead \in BOOLEAN /\ deviceOnline \in BOOLEAN
IntentRespected == record => run = "finished" /\ ShouldNotify
NoPrematureCronFinal == run = "finished" => declared \/ (~rootBusy /\ ~childBusy)
NoExecutionReplay == attempt > 0 => run = "finished"
NoReceiptClaim == delivery = "accepted" => record
\* Offline devices can display a recently resolved event. Acceptance and read
\* remain independent; the implementation must document this delivery limit.
Spec == Init /\ [][Next]_vars
=======================================================================
