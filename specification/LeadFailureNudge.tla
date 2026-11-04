---- MODULE LeadFailureNudge ----
\* Sources:
\*   src/lead-failure-nudge.mjs sha256:6388f5ee560f84849db64fa358a41827037e8e4959069b2d20113ecc2364f659
\*   src/supervisor.mjs sha256:280ac4bdfaca53e29b061ad9d9c74569546e3b8dc0406860b1727e26089df37f
\*   src/actor-coordinator.mjs sha256:d33d75f88913edccec70c1cc2df0391a3e909d958f96acfd890c3b774935ae62

\* Nobody observes Lead's own failed run, so the supervisor nudges it later.
\* Its failure report travels on the control socket, its settle on the event
\* stream. A connected run waits for the report's receipt before it settles; a
\* lost connection lets the report arrive after the settle. A settle cancels the
\* nudge only when no failure arrived since the previous settle. The nudge waits
\* while it is running. Lead must never sit idle after a failed run with no
\* nudge pending, queued, or still to be armed by a report in flight.
EXTENDS Naturals
CONSTANTS MaxRuns, CancelEverySettle
VARIABLES run, outcome, lastRun, runs, inflight, settling,
          pending, failedSinceSettled, queued

vars == <<run, outcome, lastRun, runs, inflight, settling, pending, failedSinceSettled, queued>>

Init == /\ run = "idle" /\ outcome = "none" /\ lastRun = "ok" /\ runs = 0
        /\ inflight = 0 /\ settling = FALSE
        /\ pending = FALSE /\ failedSinceSettled = FALSE /\ queued = FALSE

\* LeadFailureNudge.failed: arm unless already pending.
Failed == /\ pending' = TRUE /\ failedSinceSettled' = TRUE

\* The user's input or a delivered nudge starts a run; the provider decides its outcome.
Start == /\ run = "idle" /\ ~settling /\ runs < MaxRuns
         /\ run' = "running" /\ runs' = runs + 1 /\ queued' = FALSE
         /\ outcome' \in {"ok", "failed"}
         /\ UNCHANGED <<lastRun, inflight, settling, pending, failedSinceSettled>>

\* Connected: the supervisor records the report before the coordinator emits agent_settled.
EndConnected == /\ run = "running" /\ run' = "ended" /\ settling' = TRUE
  /\ (IF outcome = "failed" THEN Failed ELSE UNCHANGED <<pending, failedSinceSettled>>)
  /\ UNCHANGED <<outcome, lastRun, runs, inflight, queued>>

\* Disconnected: the journaled report is delivered on reconnection, after the settle.
EndDisconnected == /\ run = "running" /\ outcome = "failed" /\ run' = "ended" /\ settling' = TRUE
  /\ inflight' = inflight + 1
  /\ UNCHANGED <<outcome, lastRun, runs, pending, failedSinceSettled, queued>>

\* The supervisor handles agent_settled: LeadFailureNudge.settled, and activity becomes idle.
Settle == /\ settling /\ settling' = FALSE /\ run' = "idle" /\ lastRun' = outcome
  /\ pending' = (IF CancelEverySettle \/ ~failedSinceSettled THEN FALSE ELSE pending)
  /\ failedSinceSettled' = FALSE
  /\ UNCHANGED <<outcome, runs, inflight, queued>>

LateReport == /\ inflight > 0 /\ inflight' = inflight - 1 /\ Failed
  /\ UNCHANGED <<run, outcome, lastRun, runs, settling, queued>>

\* The tick queues a due nudge only while Lead's activity is not working.
Nudge == /\ pending /\ run = "idle" /\ ~settling
  /\ queued' = TRUE /\ pending' = FALSE
  /\ UNCHANGED <<run, outcome, lastRun, runs, inflight, settling, failedSinceSettled>>

\* The run bound ends exploration; it is not a deadlock in the modeled system.
Done == runs = MaxRuns /\ UNCHANGED vars
Next == Start \/ EndConnected \/ EndDisconnected \/ Settle \/ LateReport \/ Nudge \/ Done
Spec == Init /\ [][Next]_vars

NeverStranded == (run = "idle" /\ ~settling /\ lastRun = "failed")
  => (pending \/ queued \/ inflight > 0)
====
