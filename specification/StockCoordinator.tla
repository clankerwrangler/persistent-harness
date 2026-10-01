----------------------- MODULE StockCoordinator -----------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANT Calls, PrepareCustomPrompt
VARIABLES life, mode, flight, requests, states, results, anchored, effects,
          steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState
baseVars == <<life, mode, flight, requests, states, results, anchored, effects,
          steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected>>
vars == <<life, mode, flight, requests, states, results, anchored, effects,
          steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
Terminal == {"saved", "save-failed", "cancelled", "unknown"}
Busy == {c \in Calls: states[c] \in {"admitted", "executing"}}
Complete == \A c \in anchored: states[c] \in (Terminal \cup {"saving"}) /\ results[c] # "none"
PromptInitial == [phase |-> "idle", run |-> 0, preparedRun |-> 0,
                  queue |-> <<>>, accepted |-> 0, userIds |-> {}, deliveredUsers |-> {},
                  allowFollow |-> TRUE, needsInference |-> FALSE, requests |-> 0,
                  hooks |-> <<>>, injected |-> <<>>, sentRun |-> 0, sentPreparedRun |-> 0]
Init == /\ life = "running" /\ mode \in {"ordinary", "native"}
        /\ flight = FALSE /\ requests = 0 /\ states = [c \in Calls |-> "absent"]
        /\ results = [c \in Calls |-> "none"] /\ anchored = {} /\ effects = <<>>
        /\ steer = FALSE /\ follow = FALSE /\ steerAccepted = FALSE /\ followAccepted = FALSE
        /\ diagnostic = TRUE /\ crashed = FALSE /\ rejected = FALSE
        /\ promptState = PromptInitial
Infer == /\ life = "running" /\ ~flight /\ diagnostic /\ requests < 2
         /\ (requests = 0 \/ steer \/ follow \/ Complete)
         /\ (mode = "native" \/ Busy = {})
         /\ flight' = TRUE /\ requests' = requests + 1 /\ steer' = FALSE
         /\ follow' = IF Complete /\ ~steer THEN FALSE ELSE follow
         /\ UNCHANGED <<life, mode, states, results, anchored, effects, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
EndResponse == /\ flight /\ flight' = FALSE
               /\ UNCHANGED <<life, mode, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
Admit(c) == /\ life = "running" /\ states[c] = "absent" /\ requests = 1
            /\ ~(rejected /\ c = "b")
            /\ (mode = "native" \/ ~flight)
            /\ (c = "a" \/ states["a"] # "absent")
            /\ states' = [states EXCEPT ![c] = "admitted"] /\ anchored' = anchored \cup {c}
            /\ UNCHANGED <<life, mode, flight, requests, results, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
RejectUnconfirmed == /\ states["b"] = "absent" /\ ~rejected /\ rejected' = TRUE
                     /\ UNCHANGED <<life, mode, flight, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, promptState>>
Start(c) == /\ life = "running" /\ states[c] = "admitted" /\ c \in anchored
            /\ ~\E d \in Calls: states[d] \in {"executing", "saving"}
            /\ (c = "a" \/ states["a"] \in Terminal)
            /\ states' = [states EXCEPT ![c] = "executing"] /\ effects' = Append(effects, c)
            /\ UNCHANGED <<life, mode, flight, requests, results, anchored, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
Return(c) == /\ life \in {"running", "stopping"} /\ states[c] = "executing"
             /\ states' = [states EXCEPT ![c] = "saving"] /\ results' = [results EXCEPT ![c] = "real"]
             /\ UNCHANGED <<life, mode, flight, requests, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
Checkpoint(c, outcome) == /\ states[c] = "saving" /\ outcome \in {"saved", "save-failed"}
                         /\ states' = [states EXCEPT ![c] = outcome]
                         /\ UNCHANGED <<life, mode, flight, requests, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
AcceptSteer == /\ life # "settled" /\ ~steerAccepted /\ steerAccepted' = TRUE /\ steer' = TRUE
               /\ UNCHANGED <<life, mode, flight, requests, states, results, anchored, effects, follow, followAccepted, diagnostic, crashed, rejected, promptState>>
AcceptFollow == /\ life # "settled" /\ ~followAccepted /\ followAccepted' = TRUE /\ follow' = TRUE
                /\ UNCHANGED <<life, mode, flight, requests, states, results, anchored, effects, steer, steerAccepted, diagnostic, crashed, rejected, promptState>>
Abort == /\ life = "running" /\ life' = "stopping" /\ flight' = FALSE
         /\ UNCHANGED <<mode, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
CancelQueued(c) == /\ life = "stopping" /\ states[c] = "admitted"
                   /\ states' = [states EXCEPT ![c] = "cancelled"] /\ results' = [results EXCEPT ![c] = "cancelled"]
                   /\ UNCHANGED <<life, mode, flight, requests, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
Crash == /\ ~crashed /\ life \in {"running", "stopping"} /\ crashed' = TRUE
         /\ life' = "recovering" /\ flight' = FALSE /\ diagnostic' = FALSE
         /\ states' = [c \in Calls |-> IF states[c] = "executing" THEN "unknown" ELSE IF states[c] = "admitted" THEN "cancelled" ELSE IF states[c] = "saving" THEN "save-failed" ELSE states[c]]
         /\ UNCHANGED <<mode, requests, results, anchored, effects, steer, follow, steerAccepted, followAccepted, rejected, promptState>>
Repair(c) == /\ life = "recovering" /\ c \in anchored /\ results[c] = "none" /\ states[c] \in {"unknown", "cancelled"}
             /\ results' = [results EXCEPT ![c] = states[c]]
             /\ UNCHANGED <<life, mode, flight, requests, states, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
Recover == /\ life = "recovering" /\ Complete /\ diagnostic' = TRUE /\ life' = "running"
           /\ UNCHANGED <<mode, flight, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, crashed, rejected, promptState>>
Settle == /\ life \in {"running", "stopping"} /\ ~flight /\ Complete /\ requests > 0
          /\ (life = "stopping" \/ (~steer /\ ~follow))
          /\ life' = "settled"
          /\ UNCHANGED <<mode, flight, requests, states, results, anchored, effects, steer, follow, steerAccepted, followAccepted, diagnostic, crashed, rejected, promptState>>
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

\* Bounded prompt/queue projection of the same coordinator. PromptSpec holds the
\* tool-state variables fixed to check prompt ownership independently.
PromptCanDeliver == Len(promptState.queue) > 0 /\
                    (Head(promptState.queue).delivery = "auto" \/ promptState.allowFollow)
PromptAccept(kind, delivery) ==
    /\ promptState.accepted < 3 /\ Len(promptState.queue) < 2
    /\ promptState' = [promptState EXCEPT
        !.accepted = @ + 1,
        !.userIds = IF kind = "user" THEN @ \cup {promptState.accepted + 1} ELSE @,
        !.queue = Append(@, [kind |-> kind, delivery |-> delivery, id |-> promptState.accepted + 1])]
PromptStart == /\ promptState.phase = "idle" /\ Len(promptState.queue) > 0 /\ promptState.run < 2
               /\ promptState' = [promptState EXCEPT !.phase = "running", !.run = @ + 1,
                   !.preparedRun = 0, !.allowFollow = TRUE, !.needsInference = FALSE]
PromptDeliver ==
    /\ promptState.phase = "running" /\ PromptCanDeliver
    /\ LET item == Head(promptState.queue)
           key == <<"user", item.id, promptState.run>>
       IN promptState' = [promptState EXCEPT !.queue = Tail(@), !.needsInference = TRUE,
           !.preparedRun = IF item.kind = "user" THEN promptState.run ELSE @,
           !.deliveredUsers = IF item.kind = "user" THEN @ \cup {item.id} ELSE @,
           !.hooks = IF item.kind = "user" THEN Append(@, key) ELSE @,
           !.injected = IF item.kind = "user" THEN Append(@, key) ELSE @]
PromptPrepareNeutral ==
    /\ PrepareCustomPrompt /\ promptState.phase = "running" /\ ~PromptCanDeliver
    /\ promptState.needsInference /\ promptState.preparedRun # promptState.run
    /\ LET key == <<"neutral", 0, promptState.run>>
       IN promptState' = [promptState EXCEPT !.preparedRun = promptState.run,
           !.hooks = Append(@, key), !.injected = Append(@, key)]
PromptInfer == /\ promptState.phase = "running" /\ ~PromptCanDeliver
               /\ promptState.needsInference /\ promptState.requests < 4
               /\ (~PrepareCustomPrompt \/ promptState.preparedRun = promptState.run)
               /\ promptState' = [promptState EXCEPT !.phase = "flight", !.requests = @ + 1,
                   !.sentRun = promptState.run, !.sentPreparedRun = promptState.preparedRun,
                   !.needsInference = FALSE, !.allowFollow = FALSE]
PromptResponse(outcome) ==
    /\ promptState.phase = "flight"
    /\ promptState' = [promptState EXCEPT !.phase = "running",
        !.allowFollow = outcome = "stop", !.needsInference = outcome = "tool"]
PromptSettle == /\ promptState.phase = "running" /\ ~PromptCanDeliver /\ ~promptState.needsInference
                /\ promptState' = [promptState EXCEPT !.phase = "idle"]
PromptNext == /\ (PromptStart \/ PromptDeliver \/ PromptPrepareNeutral \/ PromptInfer \/ PromptSettle
                 \/ (\E kind \in {"user", "custom"}, delivery \in {"auto", "follow"}: PromptAccept(kind, delivery))
                 \/ (\E outcome \in {"tool", "stop"}: PromptResponse(outcome)))
              /\ UNCHANGED baseVars
PromptTypeOK == /\ promptState.phase \in {"idle", "running", "flight"}
                /\ promptState.run \in 0..2 /\ promptState.preparedRun \in 0..2
                /\ promptState.accepted \in 0..3 /\ Len(promptState.queue) <= 2
                /\ promptState.requests \in 0..4
PromptCurrentRun == promptState.phase = "flight" => promptState.sentPreparedRun = promptState.sentRun
PromptNoStaleOverride == promptState.preparedRun \in {0, promptState.run}
PromptExactlyOnce == /\ promptState.injected = promptState.hooks
                     /\ Len(promptState.injected) = Cardinality({promptState.injected[i]: i \in 1..Len(promptState.injected)})
PromptNoPromotion == /\ promptState.deliveredUsers \subseteq promptState.userIds
                     /\ \A i \in 1..Len(promptState.hooks):
                         LET key == promptState.hooks[i]
                         IN (key[1] = "neutral" /\ key[2] = 0) \/ (key[1] = "user" /\ key[2] \in promptState.userIds)
PromptSpec == Init /\ [][PromptNext]_vars
=============================================================================
