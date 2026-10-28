--------------------- MODULE ActorInputReconciliation ---------------------
EXTENDS Naturals, FiniteSets
CONSTANTS ReconcileHistory, SingleFlightReports
VARIABLES ready, generation, pending, proof, accepted, writes, delivered,
          incremental, admitted, stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault
vars == <<ready, generation, pending, proof, accepted, writes, delivered,
          incremental, admitted, stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault>>
Inputs == {"old", "new", "completed"}
Callers == {"flush1", "flush2", "handle"}
Init == /\ ready = FALSE /\ generation = 1 /\ pending = {"old"}
        /\ proof \in [Inputs -> {"absent", "proven", "ambiguous"}]
        /\ proof["completed"] = "proven" /\ proof["new"] = "absent"
        /\ accepted = [i \in Inputs |-> 0] /\ writes = [i \in Inputs |-> 0]
        /\ delivered = {"completed"} /\ incremental = {} /\ admitted = FALSE
        /\ stopped = FALSE /\ compacting \in BOOLEAN /\ startupQueries = {}
        /\ reporting = {} /\ callers = [c \in Callers |-> "none"]
        /\ reportEpoch = [i \in Inputs |-> 0] /\ reportFault = FALSE

\* Actor startup takes an append cursor, not historical receipt RPCs. The
\* supervisor already owns pending reconciliation before every transport submit.
\* VisibleInputProofs models that reader boundary: compact render evidence never
\* replaces physical verification of the requested input and its full inventory.
Start == /\ ~ready /\ ~stopped /\ ready' = TRUE
         /\ UNCHANGED <<generation, pending, proof, accepted, writes, delivered,
                        incremental, admitted, stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault>>
Admit == /\ ~admitted /\ ~stopped /\ admitted' = TRUE /\ pending' = pending \cup {"new"}
         /\ UNCHANGED <<ready, generation, proof, accepted, writes, delivered,
                        incremental, stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault>>
Reconcile(i) == /\ ReconcileHistory /\ ready /\ ~stopped /\ i \in pending /\ proof[i] = "proven"
                /\ pending' = pending \ {i} /\ delivered' = delivered \cup {i}
                /\ UNCHANGED <<ready, generation, proof, accepted, writes, incremental,
                               admitted, stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault>>
Submit(i) == /\ ready /\ ~stopped /\ i \in pending /\ proof[i] = "absent"
             /\ accepted[i] # generation /\ accepted' = [accepted EXCEPT ![i] = generation]
             /\ UNCHANGED <<ready, generation, pending, proof, writes, delivered,
                            incremental, admitted, stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault>>
Commit(i) == /\ ready /\ ~stopped /\ ~compacting /\ i \in pending
             /\ accepted[i] = generation /\ proof[i] = "absent"
             /\ proof' = [proof EXCEPT ![i] = "proven"]
             /\ writes' = [writes EXCEPT ![i] = @ + 1] /\ incremental' = incremental \cup {i}
             /\ UNCHANGED <<ready, generation, pending, accepted, delivered, admitted,
                            stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault>>
\* Both incremental flushes and an already-proven internal command use the same
\* per-input report owner. A waiter validates its own canonical association before
\* sharing that owner's physical proof/receipt; unrelated inputs remain independent.
BeginReport(c, i) == /\ ready /\ ~stopped /\ callers[c] = "none"
                     /\ i \in pending /\ proof[i] = "proven"
                     /\ (c = "handle" \/ i \in incremental)
                     /\ (i \notin reporting \/ reportEpoch[i] = generation)
                     /\ callers' = [callers EXCEPT ![c] = i]
                     /\ reporting' = reporting \cup {i}
                     /\ reportEpoch' = [reportEpoch EXCEPT ![i] = generation]
                     /\ reportFault' = (reportFault \/ (~SingleFlightReports /\ i \in reporting))
                     /\ UNCHANGED <<ready, generation, pending, proof, accepted, writes,
                                    delivered, incremental, admitted, stopped, compacting, startupQueries>>
Report(i) == /\ ready /\ ~stopped /\ i \in reporting /\ proof[i] = "proven" /\ reportEpoch[i] = generation
             /\ pending' = pending \ {i} /\ delivered' = delivered \cup {i}
             /\ reporting' = reporting \ {i}
             /\ callers' = [c \in Callers |-> IF callers[c] = i THEN "none" ELSE callers[c]]
             /\ UNCHANGED <<ready, generation, proof, accepted, writes, incremental,
                            admitted, stopped, compacting, startupQueries, reportEpoch, reportFault>>
\* A genuine proof/RPC failure rejects all waiters; it does not acknowledge, drop
\* the durable pending input, or prevent a later existing-boundary attempt.
FailReport(i) == /\ i \in reporting
                 /\ reporting' = reporting \ {i}
                 /\ callers' = [c \in Callers |-> IF callers[c] = i THEN "none" ELSE callers[c]]
                 /\ UNCHANGED <<ready, generation, pending, proof, accepted, writes, delivered,
                                incremental, admitted, stopped, compacting, startupQueries, reportEpoch, reportFault>>
\* A same-object extension reset revokes local waiters but retains physical
\* ownership until the old RPC settles. Old completion cannot clear new pending
\* state, and a different lifetime cannot join that RPC as its own receipt.
Reset == /\ ready /\ ~stopped /\ generation = 1
         /\ generation' = 2 /\ incremental' = {}
         /\ UNCHANGED <<ready, pending, proof, accepted, writes, delivered, admitted,
                        stopped, compacting, startupQueries, reporting, callers, reportEpoch, reportFault>>
ReleaseStaleReport(i) == /\ i \in reporting /\ reportEpoch[i] # generation
                         /\ reporting' = reporting \ {i}
                         /\ callers' = [c \in Callers |-> IF callers[c] = i THEN "none" ELSE callers[c]]
                         /\ UNCHANGED <<ready, generation, pending, proof, accepted, writes, delivered,
                                        incremental, admitted, stopped, compacting, startupQueries, reportEpoch, reportFault>>
FinishCompaction == /\ compacting /\ compacting' = FALSE
                    /\ UNCHANGED <<ready, generation, pending, proof, accepted, writes,
                                   delivered, incremental, admitted, stopped, startupQueries, reporting, callers, reportEpoch, reportFault>>
Crash == /\ ready /\ generation = 1 /\ ~stopped /\ ready' = FALSE
         /\ generation' = 2 /\ incremental' = {}
         /\ reporting' = {} /\ callers' = [c \in Callers |-> "none"]
         /\ UNCHANGED <<pending, proof, accepted, writes, delivered, admitted, stopped,
                        compacting, startupQueries, reportEpoch, reportFault>>
Stop == /\ ~stopped /\ stopped' = TRUE /\ ready' = FALSE
        /\ reporting' = {} /\ callers' = [c \in Callers |-> "none"]
         /\ UNCHANGED <<generation, pending, proof, accepted, writes, delivered, incremental,
                       admitted, compacting, startupQueries, reportEpoch, reportFault>>
Next == Start \/ Admit \/ Reset \/ FinishCompaction \/ Crash \/ Stop
        \/ (\E i \in Inputs: Reconcile(i) \/ Submit(i) \/ Commit(i) \/ Report(i) \/ FailReport(i) \/ ReleaseStaleReport(i))
        \/ (\E c \in Callers, i \in Inputs: BeginReport(c, i))
Spec == Init /\ [][Next]_vars
ProofBeforeDelivered == \A i \in delivered: proof[i] = "proven"
NoCanonicalReplay == \A i \in Inputs: writes[i] <= 1
CompletedNeverRevalidated == "completed" \notin startupQueries /\ accepted["completed"] = 0
AmbiguousNeverSubmitted == \A i \in Inputs: proof[i] = "ambiguous" => accepted[i] = 0
NoLostPending == pending \cup delivered = {"old", "completed"} \cup (IF admitted THEN {"new"} ELSE {})
HistoricalProofRecoverable == \A i \in pending:
    ready /\ ~stopped /\ proof[i] = "proven" => ENABLED Reconcile(i)
CompactionBoundaryUnchanged == compacting => \A i \in Inputs: writes[i] = 0
NoOverlappingDeliveryFence == ~reportFault
WaitersHaveOwner == \A c \in Callers: callers[c] # "none" => callers[c] \in reporting
=============================================================================
