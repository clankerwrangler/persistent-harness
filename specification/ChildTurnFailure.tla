-------------------- MODULE ChildTurnFailure --------------------
\* Sources:
\*   src/actor-coordinator.mjs sha256:d33d75f88913edccec70c1cc2df0391a3e909d958f96acfd890c3b774935ae62
\*   src/child-turn-failure.mjs sha256:3e70906dd488214003d4693ea887b959357b5fb2b7ee18074e6b90f5fc381fc9
\*   src/extension.mjs sha256:3a89d6dfc805a979efe720e1a242f9e5c515a5f98cf3c043a0c3994ba7b41567
\*   src/store.mjs sha256:82e659225f74f2e93f3b87d4b8fe1d02a50aa8d75c6a90ee51f9b32860e349e6

EXTENDS Naturals, FiniteSets
CONSTANT DurableJournal, AccountAdmitted, PreserveFirstCause, BindOperation, BindResultState
Turns == 1..2
None == [owner |-> 0, origin |-> "none", operation |-> "none", resultOwner |-> 0]
Scopes == {[owner |-> t, origin |-> o, operation |-> IF o = "drive" THEN "threshold" ELSE "result_commit", resultOwner |-> t] : t \in Turns, o \in {"drive", "tool"}}
VARIABLES turn, phase, provider, tools, journal, receipts, inFlight, effects, admitted, acceptedThrough,
          work, firstSeen, firstCause, diagnostics, attempted, sharedOperation, sharedResultOwner
base == <<turn, phase, provider, tools, journal, receipts, inFlight, effects, admitted, acceptedThrough>>
dvars == <<work, firstSeen, firstCause, diagnostics, attempted, sharedOperation, sharedResultOwner>>
vars == <<base, dvars>>
Init == /\ turn = 1 /\ phase = "prepare" /\ provider = FALSE /\ tools = FALSE
        /\ journal = [t \in Turns |-> "none"] /\ receipts = {} /\ inFlight = FALSE
        /\ effects = {} /\ admitted = FALSE /\ acceptedThrough = 0
        /\ work = {} /\ firstSeen = [t \in Turns |-> None] /\ firstCause = firstSeen
        /\ diagnostics = firstSeen /\ attempted = {} /\ sharedOperation = "none" /\ sharedResultOwner = 0
Dispatch == /\ phase = "prepare" /\ phase' = "inference" /\ provider' = TRUE
            /\ UNCHANGED <<turn,tools,journal,receipts,inFlight,effects,admitted,acceptedThrough,dvars>>
Admit == /\ phase = "inference" /\ ~tools /\ ~admitted /\ admitted' = TRUE
         /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,inFlight,effects,acceptedThrough,dvars>>
Tool == /\ phase \in {"inference", "failed", "settled"} /\ admitted /\ ~tools /\ tools' = TRUE /\ admitted' = FALSE
        /\ effects' = effects \cup {turn}
        /\ UNCHANGED <<turn,phase,provider,journal,receipts,inFlight,acceptedThrough,dvars>>
Start(c) == /\ c.owner = turn /\ phase \in {"prepare", "inference"} /\ c \notin work
            /\ work' = work \cup {c} /\ sharedOperation' = c.operation
            /\ sharedResultOwner' = IF c.origin = "tool" THEN c.owner ELSE sharedResultOwner
            /\ UNCHANGED <<base,firstSeen,firstCause,diagnostics,attempted>>
Boundary == IF tools \/ (AccountAdmitted /\ admitted) THEN "tool_effects_possible" ELSE IF provider THEN "provider_dispatch_unknown" ELSE "before_provider_dispatch"
\* Each rejected operation carries its own owner and operation across overlap.
Fail(c) == /\ c \in work /\ work' = work \ {c}
           /\ IF c.owner = turn /\ phase \in {"prepare", "inference", "failed"}
                 THEN /\ phase' = "failed"
                      /\ journal' = IF DurableJournal /\ journal[turn] = "none" THEN [journal EXCEPT ![turn] = Boundary] ELSE journal
                      /\ firstSeen' = IF firstSeen[turn] = None THEN [firstSeen EXCEPT ![turn] = c] ELSE firstSeen
                      /\ firstCause' = IF firstCause[turn] = None \/ ~PreserveFirstCause
                            THEN [firstCause EXCEPT ![turn] = [c EXCEPT !.operation = IF BindOperation THEN c.operation ELSE sharedOperation, !.resultOwner = IF BindResultState THEN c.owner ELSE sharedResultOwner]] ELSE firstCause
                 ELSE UNCHANGED <<phase,journal,firstSeen,firstCause>>
           /\ UNCHANGED <<turn,provider,tools,receipts,inFlight,effects,admitted,acceptedThrough,diagnostics,attempted,sharedOperation,sharedResultOwner>>
\* The notice is durable first; diagnostic failure cannot block its receipt.
WriteDiagnostic(success) == /\ phase = "failed" /\ turn \notin attempted
                           /\ diagnostics' = (IF success THEN [diagnostics EXCEPT ![turn] = firstCause[turn]] ELSE diagnostics)
                           /\ attempted' = attempted \cup {turn}
                           /\ UNCHANGED <<base,work,firstSeen,firstCause,sharedOperation,sharedResultOwner>>
SettleFailure == /\ phase = "failed" /\ turn \in attempted /\ phase' = "settled"
                 /\ UNCHANGED <<turn,provider,tools,journal,receipts,inFlight,effects,admitted,acceptedThrough,dvars>>
SuccessOrCancel == /\ phase \in {"prepare", "inference"} /\ phase' = "settled"
                   /\ UNCHANGED <<turn,provider,tools,journal,receipts,inFlight,effects,admitted,acceptedThrough,dvars>>
\* Input clearing does not erase a frozen cause. New logical runs have new slots.
NewInput == /\ phase = "settled" /\ ~admitted /\ turn < 2
            /\ turn' = turn + 1 /\ phase' = "prepare" /\ provider' = FALSE /\ tools' = FALSE
            /\ UNCHANGED <<journal,receipts,inFlight,effects,admitted,acceptedThrough,dvars>>
Send == /\ ~inFlight /\ \E t \in Turns: journal[t] # "none" /\ t > acceptedThrough
        /\ inFlight' = TRUE /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,effects,admitted,acceptedThrough,dvars>>
Accept(t) == /\ inFlight /\ journal[t] # "none" /\ t > acceptedThrough /\ receipts' = receipts \cup {t}
             /\ inFlight' = FALSE /\ UNCHANGED <<turn,phase,provider,tools,journal,effects,admitted,acceptedThrough,dvars>>
Witness(t) == /\ t \in receipts /\ t > acceptedThrough
              /\ \A prior \in 1..t: journal[prior] # "none" => prior \in receipts
              /\ acceptedThrough' = t
              /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,inFlight,effects,admitted,dvars>>
RestartOrReject == /\ inFlight' = FALSE
                   /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,effects,admitted,acceptedThrough,dvars>>
Next == Dispatch \/ Admit \/ Tool \/ SuccessOrCancel \/ SettleFailure \/ NewInput \/ Send \/ RestartOrReject
        \/ (\E c \in Scopes: Start(c) \/ Fail(c)) \/ (\E ok \in BOOLEAN: WriteDiagnostic(ok))
        \/ (\E t \in Turns: Accept(t) \/ Witness(t))
Spec == Init /\ [][Next]_vars
Safety == /\ (phase = "failed" => journal[turn] # "none")
          /\ (\A t \in 1..acceptedThrough: journal[t] # "none" => t \in receipts)
          /\ receipts \subseteq {t \in Turns: journal[t] # "none"}
          /\ (phase = "failed" => journal[turn] = Boundary)
          /\ (\A t \in Turns: journal[t] = "before_provider_dispatch" => t \notin effects)
          /\ (\A t \in Turns: firstCause[t] = firstSeen[t])
          /\ (\A t \in Turns: diagnostics[t] # None => /\ diagnostics[t] = firstSeen[t] /\ diagnostics[t].owner = t /\ diagnostics[t].resultOwner = t /\ journal[t] # "none")
NoticeOnly == [][(inFlight # inFlight' \/ receipts # receipts' \/ diagnostics # diagnostics') => UNCHANGED <<turn,phase,provider,tools,effects>>]_vars
=================================================================
