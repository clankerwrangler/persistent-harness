-------------------------- MODULE ActorCompaction --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Entries
\* flights/queued track driver-owned default summary requests; custom hook computation is abstract.
VARIABLES phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
          source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole
vars == <<phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
          source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole>>
Init == /\ phase = "prepare" /\ aborted = FALSE /\ sameLeaf = TRUE
        /\ hook \in {"default", "custom", "cancel", "error"}
        /\ pending \in {0, 1, 2} /\ cut \in {1, 2, 3}
        /\ kept = {} /\ writes = 0 /\ source = "none"
        /\ instructions = FALSE /\ beforeEvent = FALSE /\ terminal = 0
        /\ effects = 0 /\ canonical = Entries /\ noticeFailure \in BOOLEAN /\ flights = 0 /\ abortedProvider \in BOOLEAN /\ queued = 0 /\ instructionRole = "none"
Interrupt == /\ phase \in {"prepare", "diagnostic", "hook", "summary", "validate"}
             /\ ~aborted /\ aborted' = TRUE
             /\ UNCHANGED <<phase, sameLeaf, hook, pending, cut, kept, writes, source,
                            instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole>>
Move == /\ phase \in {"diagnostic", "hook", "summary", "validate"} /\ sameLeaf
        /\ sameLeaf' = FALSE
        /\ UNCHANGED <<phase, aborted, hook, pending, cut, kept, writes, source,
                       instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole>>
Fail == /\ phase \in {"prepare", "diagnostic", "hook", "summary", "validate"}
        /\ (aborted \/ ~sameLeaf \/ (phase = "diagnostic" /\ pending # 0) \/ (phase = "hook" /\ hook \in {"cancel", "error"}) \/
            (phase = "summary" /\ source = "default" /\ abortedProvider))
        /\ phase' = "done" /\ terminal' = 1 /\ flights' = 0 /\ queued' = 0
        /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                       instructions, beforeEvent, effects, canonical, noticeFailure, abortedProvider, instructionRole>>
Prepare == /\ phase = "prepare" /\ ~aborted /\ sameLeaf
           /\ kept' = {e \in Entries : e >= IF pending = 0 THEN cut ELSE
                               IF pending < cut THEN pending ELSE cut}
           /\ phase' = "diagnostic"
           /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, writes, source,
                          instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole>>
Diagnostic == /\ phase = "diagnostic" /\ ~aborted /\ sameLeaf /\ pending = 0
              /\ instructions' = TRUE /\ instructionRole' = "user" /\ phase' = "hook"
              /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                             beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued>>
Hook == /\ phase = "hook" /\ ~aborted /\ sameLeaf
        /\ hook \in {"default", "custom"} /\ beforeEvent' = TRUE
        /\ source' = hook /\ phase' = "summary" /\ queued' = IF hook = "default" THEN 2 ELSE 0
        /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes,
                       instructions, terminal, effects, canonical, noticeFailure, flights, abortedProvider, instructionRole>>
Summarize == /\ phase = "summary" /\ ~aborted /\ sameLeaf /\ phase' = "validate" /\ queued = 0 /\ flights = 0
             /\ (source # "default" \/ ~abortedProvider)
             /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                            instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole>>
Commit == /\ phase = "validate" /\ ~aborted /\ sameLeaf
          /\ writes' = 1 /\ phase' = "notify"
          /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, source,
                         instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole>>
Notify == /\ phase = "notify" /\ phase' = "done" /\ terminal' = 1
          /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                         instructions, beforeEvent, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole>>
StartSummary == /\ phase = "summary" /\ source = "default" /\ ~aborted /\ sameLeaf
                /\ queued > 0 /\ flights = 0 /\ flights' = 1 /\ queued' = queued - 1
                /\ UNCHANGED <<phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
                  source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure,
                  abortedProvider, instructionRole>>
FinishSummary == /\ phase = "summary" /\ flights = 1 /\ flights' = 0
                 /\ UNCHANGED <<phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
                  source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure,
                  abortedProvider, queued, instructionRole>>
Next == StartSummary \/ FinishSummary \/ Interrupt \/ Move \/ Fail \/ Prepare \/ Diagnostic \/ Hook \/ Summarize \/ Commit \/ Notify
Spec == Init /\ [][Next]_vars
OneWriter == writes \in 0..1
CanonicalUnchanged == canonical = Entries
NoToolReplay == effects = 0
DiagnosticBeforeHook == beforeEvent => instructions
NoAbortAppend == writes = 1 => ~aborted /\ sameLeaf
PendingRetained == phase \in {"diagnostic", "hook", "summary", "validate", "notify"} /\ pending # 0 => pending \in kept
OneTerminal == terminal \in 0..1 /\ (phase = "done" => terminal = 1)
CommitHasSource == writes = 1 => source \in {"default", "custom"} /\ beforeEvent
NoActiveTerminal == terminal = 1 => flights = 0 /\ queued = 0
NoAbortedSummary == writes = 1 /\ source = "default" => ~abortedProvider
SingleProviderFlight == flights \in 0..1
InstructionsNotElevated == instructions => instructionRole = "user"
CustomHookSkipsDefaultProvider == source = "custom" => flights = 0 /\ queued = 0
NoUnansweredCompaction == writes = 1 => pending = 0
=============================================================================
