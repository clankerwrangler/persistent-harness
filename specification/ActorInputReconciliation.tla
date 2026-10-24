--------------------- MODULE ActorInputReconciliation ---------------------
EXTENDS Naturals, FiniteSets
CONSTANT ReconcileHistory
VARIABLES ready, generation, pending, proof, accepted, writes, delivered,
          incremental, admitted, stopped, compacting, startupQueries
vars == <<ready, generation, pending, proof, accepted, writes, delivered,
          incremental, admitted, stopped, compacting, startupQueries>>
Inputs == {"old", "new", "completed"}
Init == /\ ready = FALSE /\ generation = 1 /\ pending = {"old"}
        /\ proof \in [Inputs -> {"absent", "proven", "ambiguous"}]
        /\ proof["completed"] = "proven" /\ proof["new"] = "absent"
        /\ accepted = [i \in Inputs |-> 0] /\ writes = [i \in Inputs |-> 0]
        /\ delivered = {"completed"} /\ incremental = {} /\ admitted = FALSE
        /\ stopped = FALSE /\ compacting \in BOOLEAN /\ startupQueries = {}

\* Actor startup takes an append cursor, not historical receipt RPCs. The
\* supervisor already owns pending reconciliation before every transport submit.
\* VisibleInputProofs models that reader boundary: compact render evidence never
\* replaces physical verification of the requested input and its full inventory.
Start == /\ ~ready /\ ~stopped /\ ready' = TRUE
         /\ UNCHANGED <<generation, pending, proof, accepted, writes, delivered,
                        incremental, admitted, stopped, compacting, startupQueries>>
Admit == /\ ~admitted /\ ~stopped /\ admitted' = TRUE /\ pending' = pending \cup {"new"}
         /\ UNCHANGED <<ready, generation, proof, accepted, writes, delivered,
                        incremental, stopped, compacting, startupQueries>>
Reconcile(i) == /\ ReconcileHistory /\ ready /\ ~stopped /\ i \in pending /\ proof[i] = "proven"
                /\ pending' = pending \ {i} /\ delivered' = delivered \cup {i}
                /\ UNCHANGED <<ready, generation, proof, accepted, writes, incremental,
                               admitted, stopped, compacting, startupQueries>>
Submit(i) == /\ ready /\ ~stopped /\ i \in pending /\ proof[i] = "absent"
             /\ accepted[i] # generation /\ accepted' = [accepted EXCEPT ![i] = generation]
             /\ UNCHANGED <<ready, generation, pending, proof, writes, delivered,
                            incremental, admitted, stopped, compacting, startupQueries>>
Commit(i) == /\ ready /\ ~stopped /\ ~compacting /\ i \in pending
             /\ accepted[i] = generation /\ proof[i] = "absent"
             /\ proof' = [proof EXCEPT ![i] = "proven"]
             /\ writes' = [writes EXCEPT ![i] = @ + 1] /\ incremental' = incremental \cup {i}
             /\ UNCHANGED <<ready, generation, pending, accepted, delivered, admitted,
                            stopped, compacting, startupQueries>>
Report(i) == /\ ready /\ ~stopped /\ i \in incremental /\ i \in pending /\ proof[i] = "proven"
             /\ pending' = pending \ {i} /\ delivered' = delivered \cup {i}
             /\ UNCHANGED <<ready, generation, proof, accepted, writes, incremental,
                            admitted, stopped, compacting, startupQueries>>
FinishCompaction == /\ compacting /\ compacting' = FALSE
                    /\ UNCHANGED <<ready, generation, pending, proof, accepted, writes,
                                   delivered, incremental, admitted, stopped, startupQueries>>
Crash == /\ ready /\ generation = 1 /\ ~stopped /\ ready' = FALSE
         /\ generation' = 2 /\ incremental' = {}
         /\ UNCHANGED <<pending, proof, accepted, writes, delivered, admitted, stopped,
                        compacting, startupQueries>>
Stop == /\ ~stopped /\ stopped' = TRUE /\ ready' = FALSE
        /\ UNCHANGED <<generation, pending, proof, accepted, writes, delivered, incremental,
                       admitted, compacting, startupQueries>>
Next == Start \/ Admit \/ FinishCompaction \/ Crash \/ Stop
        \/ (\E i \in Inputs: Reconcile(i) \/ Submit(i) \/ Commit(i) \/ Report(i))
Spec == Init /\ [][Next]_vars
ProofBeforeDelivered == \A i \in delivered: proof[i] = "proven"
NoCanonicalReplay == \A i \in Inputs: writes[i] <= 1
CompletedNeverRevalidated == "completed" \notin startupQueries /\ accepted["completed"] = 0
AmbiguousNeverSubmitted == \A i \in Inputs: proof[i] = "ambiguous" => accepted[i] = 0
NoLostPending == pending \cup delivered = {"old", "completed"} \cup (IF admitted THEN {"new"} ELSE {})
HistoricalProofRecoverable == \A i \in pending:
    ready /\ ~stopped /\ proof[i] = "proven" => ENABLED Reconcile(i)
CompactionBoundaryUnchanged == compacting => \A i \in Inputs: writes[i] = 0
=============================================================================
