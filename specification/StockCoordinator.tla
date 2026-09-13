----------------------- MODULE StockCoordinator -----------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANT Calls
VARIABLES life, mode, flight, requests, states, results, anchored, effects,
          steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected
vars == <<life, mode, flight, requests, states, results, anchored, effects,
          steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
Terminal == {"saved", "save-failed", "cancelled", "unknown"}
Busy == {c \in Calls: states[c] \in {"admitted", "executing"}}
Complete == \A c \in anchored: states[c] \in (Terminal \cup {"saving"}) /\ results[c] # "none"
Init == /\ life = "running" /\ mode \in {"ordinary", "native"}
        /\ flight = FALSE /\ requests = 0 /\ states = [c \in Calls |-> "absent"]
        /\ results = [c \in Calls |-> "none"] /\ anchored = {} /\ effects = <<>>
        /\ steer = FALSE /\ follow = FALSE /\ steerAccepted = FALSE /\ followAccepted = FALSE
        /\ diagnostic = TRUE /\ crashed = FALSE /\ rejected = FALSE
Infer == /\ life = "running" /\ ~flight /\ diagnostic /\ requests < 2
         /\ (requests = 0 \/ steer \/ follow \/ Complete)
         /\ (mode = "native" \/ Busy = {})
         /\ flight' = TRUE /\ requests' = requests + 1 /\ steer' = FALSE
         /\ follow' = IF Complete /\ ~steer THEN FALSE ELSE follow
         /\ UNCHANGED <<life, mode, states, results, anchored, effects, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
EndResponse == /\ flight /\ flight' = FALSE
               /\ UNCHANGED <<life, mode, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
Admit(c) == /\ life = "running" /\ states[c] = "absent" /\ requests = 1
            /\ ~(rejected /\ c = "b")
            /\ (mode = "native" \/ ~flight)
            /\ (c = "a" \/ states["a"] # "absent")
            /\ states' = [states EXCEPT ![c] = "admitted"] /\ anchored' = anchored \cup {c}
            /\ UNCHANGED <<life, mode, flight, requests, results, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
RejectUnconfirmed == /\ states["b"] = "absent" /\ ~rejected /\ rejected' = TRUE
                     /\ UNCHANGED <<life, mode, flight, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed>>
Start(c) == /\ life = "running" /\ states[c] = "admitted" /\ c \in anchored
            /\ ~\E d \in Calls: states[d] \in {"executing", "saving"}
            /\ (c = "a" \/ states["a"] \in Terminal)
            /\ states' = [states EXCEPT ![c] = "executing"] /\ effects' = Append(effects, c)
            /\ UNCHANGED <<life, mode, flight, requests, results, anchored, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
Return(c) == /\ life \in {"running", "stopping"} /\ states[c] = "executing"
             /\ states' = [states EXCEPT ![c] = "saving"] /\ results' = [results EXCEPT ![c] = "real"]
             /\ UNCHANGED <<life, mode, flight, requests, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
Checkpoint(c, outcome) == /\ states[c] = "saving" /\ outcome \in {"saved", "save-failed"}
                         /\ states' = [states EXCEPT ![c] = outcome]
                         /\ UNCHANGED <<life, mode, flight, requests, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
AcceptSteer == /\ life # "settled" /\ ~steerAccepted /\ steerAccepted' = TRUE /\ steer' = TRUE
               /\ UNCHANGED <<life, mode, flight, requests, states, results, anchored, effects, follow, followAccepted, diagnostic, crashed, rejected>>
AcceptFollow == /\ life # "settled" /\ ~followAccepted /\ followAccepted' = TRUE /\ follow' = TRUE
                /\ UNCHANGED <<life, mode, flight, requests, states, results, anchored, effects, steer, steerAccepted, diagnostic, crashed, rejected>>
Abort == /\ life = "running" /\ life' = "stopping" /\ flight' = FALSE
         /\ UNCHANGED <<mode, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
CancelQueued(c) == /\ life = "stopping" /\ states[c] = "admitted"
                   /\ states' = [states EXCEPT ![c] = "cancelled"] /\ results' = [results EXCEPT ![c] = "cancelled"]
                   /\ UNCHANGED <<life, mode, flight, requests, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
Crash == /\ ~crashed /\ life \in {"running", "stopping"} /\ crashed' = TRUE
         /\ life' = "recovering" /\ flight' = FALSE /\ diagnostic' = FALSE
         /\ states' = [c \in Calls |-> IF states[c] = "executing" THEN "unknown" ELSE IF states[c] = "admitted" THEN "cancelled" ELSE IF states[c] = "saving" THEN "save-failed" ELSE states[c]]
         /\ UNCHANGED <<mode, requests, results, anchored, effects, steer, follow, steerAccepted, followAccepted, rejected>>
Repair(c) == /\ life = "recovering" /\ c \in anchored /\ results[c] = "none" /\ states[c] \in {"unknown", "cancelled"}
             /\ results' = [results EXCEPT ![c] = states[c]]
             /\ UNCHANGED <<life, mode, flight, requests, states, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
Recover == /\ life = "recovering" /\ Complete /\ diagnostic' = TRUE /\ life' = "running"
           /\ UNCHANGED <<mode, flight, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, crashed, rejected>>
Settle == /\ life \in {"running", "stopping"} /\ ~flight /\ Complete /\ requests > 0
          /\ (life = "stopping" \/ (~steer /\ ~follow))
          /\ life' = "settled"
          /\ UNCHANGED <<mode, flight, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
Next == Infer \/ EndResponse \/ RejectUnconfirmed \/ AcceptSteer \/ AcceptFollow \/ Abort \/ Crash \/ Recover \/ Settle
        \/ (\E c \in Calls: Admit(c) \/ Start(c) \/ Return(c) \/ CancelQueued(c) \/ Repair(c) \/ (\E o \in {"saved", "save-failed"}: Checkpoint(c,o)))
TypeOK == /\ life \in {"running", "stopping", "recovering", "settled"}
          /\ mode \in {"ordinary", "native"} /\ requests \in 0..2
          /\ anchored \subseteq Calls /\ states \in [Calls -> {"absent", "admitted", "executing", "saving", "saved", "save-failed", "cancelled", "unknown"}]
          /\ results \in [Calls -> {"none", "real", "unknown", "cancelled"}]
OneKernel == Cardinality({c \in Calls: states[c] \in {"executing", "saving"}}) <= 1
NoReplay == Len(effects) = Cardinality({effects[i]: i \in 1..Len(effects)})
AnchoredEffects == {effects[i]: i \in 1..Len(effects)} \subseteq anchored
RealResults == \A c \in Calls: results[c] = "real" => c \in {effects[i]: i \in 1..Len(effects)}
SettledMeansNoWork == life = "settled" => ~flight /\ Busy = {} /\ Complete
NoInferenceWithoutDiagnostic == flight => diagnostic
RejectedNeverAdmitted == rejected => "b" \notin anchored
Spec == Init /\ [][Next]_vars
=============================================================================
