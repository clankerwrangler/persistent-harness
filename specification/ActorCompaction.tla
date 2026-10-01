-------------------------- MODULE ActorCompaction --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Entries
\* flights/queued track driver-owned default summary requests; custom hook computation is abstract.
VARIABLES phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
          source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh
vars == <<phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
          source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Init == /\ phase = "prepare" /\ aborted = FALSE /\ sameLeaf = TRUE
        /\ hook \in {"default", "custom", "cancel", "error"}
        /\ pending \in {0, 1, 2} /\ cut \in {1, 2, 3}
        /\ kept = {} /\ writes = 0 /\ source = "none"
        /\ instructions = FALSE /\ beforeEvent = FALSE /\ terminal = 0
        /\ effects = 0 /\ canonical = Entries /\ noticeFailure \in BOOLEAN /\ flights = 0 /\ abortedProvider \in BOOLEAN /\ queued = 0 /\ instructionRole = "none" /\ captured = FALSE /\ outcome = "pending" /\ reason \in {"manual", "threshold", "overflow"}
        /\ summaryErrors = 0 /\ retries = 0 /\ continued = FALSE
        /\ stockPrepared \in BOOLEAN /\ hasCheckpoint \in BOOLEAN /\ hasAnchor \in BOOLEAN /\ refresh = FALSE
Interrupt == /\ phase \in {"prepare", "capture", "diagnostic", "hook", "summary", "validate"}
             /\ ~aborted /\ aborted' = TRUE
             /\ UNCHANGED <<phase, sameLeaf, hook, pending, cut, kept, writes, source,
                            instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Move == /\ phase \in {"diagnostic", "hook", "summary", "validate"} /\ sameLeaf
        /\ sameLeaf' = FALSE
        /\ UNCHANGED <<phase, aborted, hook, pending, cut, kept, writes, source,
                       instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Fail == /\ phase \in {"prepare", "capture", "diagnostic", "hook", "summary", "validate"}
        /\ (aborted \/ ~sameLeaf \/ (phase = "diagnostic" /\ pending # 0) \/ (phase = "hook" /\ hook = "error") \/
            (phase = "summary" /\ source = "default" /\ abortedProvider) \/
            (phase = "capture" /\ ~stockPrepared /\ ~(reason = "manual" /\ hasCheckpoint /\ hasAnchor)))
        /\ phase' = "done" /\ terminal' = 1 /\ flights' = 0 /\ queued' = 0
        /\ outcome' = "failed" /\ summaryErrors' = IF reason # "manual" /\ ~aborted THEN 1 ELSE 0
        /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                       instructions, beforeEvent, effects, canonical, noticeFailure, abortedProvider, instructionRole, captured, reason, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Capture == /\ phase = "prepare" /\ ~aborted /\ sameLeaf
           /\ phase' = "capture" /\ captured' = TRUE
           /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                 instructions, beforeEvent, terminal, effects, canonical, noticeFailure,
                 flights, abortedProvider, queued, instructionRole, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Prepare == /\ phase = "capture" /\ ~aborted /\ sameLeaf
           /\ (stockPrepared \/ (reason = "manual" /\ hasCheckpoint /\ hasAnchor))
           /\ refresh' = ~stockPrepared
           /\ kept' = IF refresh' THEN Entries ELSE {e \in Entries : e >= IF pending = 0 THEN cut ELSE
                               IF pending < cut THEN pending ELSE cut}
           /\ phase' = "diagnostic"
           /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, writes, source,
                          instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor>>
Diagnostic == /\ phase = "diagnostic" /\ ~aborted /\ sameLeaf /\ pending = 0
              /\ instructions' = TRUE /\ instructionRole' = "user" /\ phase' = "hook"
              /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                             beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Hook == /\ phase = "hook" /\ ~aborted /\ sameLeaf
        /\ hook \in {"default", "custom"} /\ beforeEvent' = TRUE
        /\ source' = hook /\ phase' = "summary" /\ queued' = IF hook = "default" THEN 2 ELSE 0
        /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes,
                       instructions, terminal, effects, canonical, noticeFailure, flights, abortedProvider, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Summarize == /\ phase = "summary" /\ ~aborted /\ sameLeaf /\ phase' = "validate" /\ queued = 0 /\ flights = 0
             /\ (source # "default" \/ ~abortedProvider)
             /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                            instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Commit == /\ phase = "validate" /\ ~aborted /\ sameLeaf
          /\ writes' = 1 /\ phase' = "notify" /\ outcome' = "committed"
          /\ retries' = IF reason = "overflow" THEN 1 ELSE 0
          /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, source,
                         instructions, beforeEvent, terminal, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, reason, summaryErrors, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Notify == /\ phase = "notify" /\ phase' = "done" /\ terminal' = 1
          /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                         instructions, beforeEvent, effects, canonical, noticeFailure, flights, abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
StartSummary == /\ phase = "summary" /\ source = "default" /\ ~aborted /\ sameLeaf
                /\ queued > 0 /\ flights = 0 /\ flights' = 1 /\ queued' = queued - 1
                /\ UNCHANGED <<phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
                  source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure,
                  abortedProvider, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
FinishSummary == /\ phase = "summary" /\ flights = 1 /\ flights' = 0
                 /\ UNCHANGED <<phase, aborted, sameLeaf, hook, pending, cut, kept, writes,
                  source, instructions, beforeEvent, terminal, effects, canonical, noticeFailure,
                  abortedProvider, queued, instructionRole, captured, outcome, reason, summaryErrors, retries, continued, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Cancel == /\ phase = "hook" /\ ~aborted /\ sameLeaf /\ hook = "cancel"
          /\ phase' = "done" /\ terminal' = 1 /\ outcome' = "cancelled"
          /\ continued' = (reason = "threshold")
          /\ UNCHANGED <<aborted, sameLeaf, hook, pending, cut, kept, writes, source,
                         instructions, beforeEvent, effects, canonical, noticeFailure, flights,
                         abortedProvider, queued, instructionRole, captured, reason, summaryErrors, retries, stockPrepared, hasCheckpoint, hasAnchor, refresh>>
Next == Cancel \/ Capture \/ StartSummary \/ FinishSummary \/ Interrupt \/ Move \/ Fail \/ Prepare \/ Diagnostic \/ Hook \/ Summarize \/ Commit \/ Notify
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
StockCaptureOnly == phase = "capture" => writes = 0 /\ effects = 0 /\ flights = 0 /\ ~beforeEvent
CaptureBeforeActiveHooks == beforeEvent => captured
CancellationIsNotFailure == outcome = "cancelled" => writes = 0 /\ summaryErrors = 0 /\ retries = 0
ThresholdCancellationContinues == outcome = "cancelled" => continued = (reason = "threshold")
OnlyCommittedOverflowRetries == retries = 1 => outcome = "committed" /\ reason = "overflow" /\ writes = 1
RefreshRetainsFullTail == refresh => reason = "manual" /\ hasCheckpoint /\ hasAnchor /\ ~stockPrepared /\ kept = Entries
AutomaticUsesStockPreparation == beforeEvent /\ reason # "manual" => stockPrepared
=============================================================================
