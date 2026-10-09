----------------------- MODULE ActorResultLifetime -----------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS Runs, Calls, Flights
VARIABLES phase, run, flight, attempts, states, canonical, published,
          pending, delivered, released, releaseFenced
vars == <<phase, run, flight, attempts, states, canonical, published,
          pending, delivered, released, releaseFenced>>
Ids == (1..Runs) \X (1..Calls)
SeqSet(s) == {s[i] : i \in 1..Len(s)}
Tasks == {id \in Ids : states[id] \notin {"absent", "finished"}}
Current == {id \in Ids : id[1] = run}
\* Canonical append precedes public commit completion, which precedes queuing.
\* Tool task ownership lasts until after queuing; settlement fences both tasks
\* and inference. A flight can end while native tasks remain in the same run.
Init == /\ phase = "idle" /\ run = 0 /\ flight = "none" /\ attempts = 0
        /\ states = [id \in Ids |-> "absent"]
        /\ canonical = <<>> /\ published = {} /\ pending = <<>>
        /\ delivered = <<>> /\ released = {} /\ releaseFenced = TRUE
Start == /\ phase = "idle" /\ run < Runs
         /\ phase' = "active" /\ run' = run + 1 /\ attempts' = 0
         /\ UNCHANGED <<flight, states, canonical, published, pending, delivered, released, releaseFenced>>
Infer == /\ phase = "active" /\ flight = "none" /\ attempts < Flights
         /\ flight' = "live" /\ attempts' = attempts + 1
         /\ UNCHANGED <<phase, run, states, canonical, published, pending, delivered, released, releaseFenced>>
Admit(id) == /\ phase = "active" /\ flight = "live" /\ id \in Current
             /\ states[id] = "absent"
             /\ states' = [states EXCEPT ![id] = "executing"]
             /\ UNCHANGED <<phase, run, flight, attempts, canonical, published, pending, delivered, released, releaseFenced>>
Commit(id) == /\ states[id] = "executing"
              /\ ~\E other \in Ids: states[other] = "committed"
              /\ states' = [states EXCEPT ![id] = "committed"]
              /\ canonical' = Append(canonical, id)
              /\ UNCHANGED <<phase, run, flight, attempts, published, pending, delivered, released, releaseFenced>>
Publish(id) == /\ states[id] = "committed"
               /\ states' = [states EXCEPT ![id] = "published"]
               /\ published' = published \cup {id}
               /\ pending' = Append(pending, id)
               /\ UNCHANGED <<phase, run, flight, attempts, canonical, delivered, released, releaseFenced>>
Finish(id) == /\ states[id] = "published"
              /\ states' = [states EXCEPT ![id] = "finished"]
              /\ UNCHANGED <<phase, run, flight, attempts, canonical, published, pending, delivered, released, releaseFenced>>
\* Accepted normal AND explicit provider-error final events drain in order.
Terminal(outcome) == /\ phase = "active" /\ flight = "live"
                     /\ phase' = IF outcome = "error" THEN "stopping" ELSE phase
                     /\ flight' = "none"
                     /\ delivered' = Append(delivered, [run |-> run, ids |-> pending])
                     /\ pending' = <<>>
                     /\ UNCHANGED <<run, attempts, states, canonical, published, released, releaseFenced>>
\* Retired/superseded inference is not terminal logical-run ownership. A
\* continuation may consume results from an earlier flight of this same run.
Retire == /\ phase = "active" /\ flight = "live" /\ flight' = "none"
          /\ UNCHANGED <<phase, run, attempts, states, canonical, published, pending, delivered, released, releaseFenced>>
Abort == /\ phase = "active" /\ phase' = "stopping"
         /\ flight' = IF flight = "live" THEN "retired" ELSE flight
         /\ UNCHANGED <<run, attempts, states, canonical, published, pending, delivered, released, releaseFenced>>
\* The adapter's aborted terminal fails the live epoch guard; no turn_end.
CancelledTerminal == /\ phase = "stopping" /\ flight = "retired"
                     /\ flight' = "none"
                     /\ UNCHANGED <<phase, run, attempts, states, canonical, published, pending, delivered, released, releaseFenced>>
\* Mirrors settle's no-task/no-flight guards and completed canonical work.
\* Release occurs BEFORE asynchronous agent_end observers and the next run.
Settle == /\ phase \in {"active", "stopping"} /\ attempts > 0
          /\ Tasks = {} /\ flight = "none"
          /\ phase' = "idle" /\ released' = released \cup SeqSet(pending)
          /\ releaseFenced' = (releaseFenced /\ Tasks = {} /\ flight = "none")
          /\ pending' = <<>>
          /\ UNCHANGED <<run, flight, attempts, states, canonical, published, delivered>>
Next == Start \/ Infer \/ Retire \/ Abort \/ CancelledTerminal \/ Settle
        \/ (\E id \in Ids: Admit(id) \/ Commit(id) \/ Publish(id) \/ Finish(id))
        \/ (\E outcome \in {"normal", "error"}: Terminal(outcome))
TypeOK == /\ phase \in {"idle", "active", "stopping"} /\ run \in 0..Runs
          /\ flight \in {"none", "live", "retired"} /\ attempts \in 0..Flights
          /\ states \in [Ids -> {"absent", "executing", "committed", "published", "finished"}]
          /\ SeqSet(canonical) \subseteq Ids /\ published \subseteq Ids
          /\ SeqSet(pending) \subseteq Ids /\ released \subseteq Ids
DeliveredIds == UNION {SeqSet(delivered[i].ids): i \in 1..Len(delivered)}
CanonicalExactlyOnce == Len(canonical) = Cardinality(SeqSet(canonical))
CommitBeforeDelivery == (SeqSet(pending) \cup DeliveredIds \cup released) \subseteq published
                       /\ published \subseteq SeqSet(canonical)
RunLocalDelivery == /\ SeqSet(pending) \subseteq Current
                    /\ \A i \in 1..Len(delivered):
                         \A id \in SeqSet(delivered[i].ids): id[1] = delivered[i].run
SettledReleases == phase = "idle" => pending = <<>>
ReleaseAfterFence == releaseFenced /\ (phase = "idle" => Tasks = {} /\ flight = "none")
\* No loss on an intermediate flight, and no duplicate delivery or requeue.
OwnershipConserved == /\ published = SeqSet(pending) \cup DeliveredIds \cup released
                      /\ SeqSet(pending) \cap (DeliveredIds \cup released) = {}
                      /\ DeliveredIds \cap released = {}
                      /\ Len(pending) = Cardinality(SeqSet(pending))
                      /\ Cardinality(DeliveredIds) =
                           Cardinality(UNION {{<<i, id>>: id \in SeqSet(delivered[i].ids)}: i \in 1..Len(delivered)})
DeliveryOrder == \A i \in 1..Len(delivered):
                  \A j, k \in 1..Len(delivered[i].ids): j < k =>
                    \E a, b \in 1..Len(canonical):
                      a < b /\ canonical[a] = delivered[i].ids[j] /\ canonical[b] = delivered[i].ids[k]
Spec == Init /\ [][Next]_vars
=============================================================================
