------------------------- MODULE NativeFixtureHeapCap -------------------------
EXTENDS Naturals, Sequences, TLC
CONSTANT Bug
VARIABLES phase, parentCap, environment, actors, rpcArgs, rpcWorkers
vars == <<phase, parentCap, environment, actors, rpcArgs, rpcWorkers>>
Original == [cap |-> 512, foreign |-> TRUE, private |-> FALSE]
Private(cap, foreign) == [cap |-> cap, foreign |-> foreign, private |-> TRUE]
Init == /\ phase = "capture"
        /\ parentCap \in {0, 64, 256}
        /\ environment = Original
        /\ actors = <<>>
        /\ rpcArgs = [cap |-> 0, foreign |-> FALSE]
        /\ rpcWorkers = <<>>
Reset == /\ phase = "capture"
         /\ environment' = IF Bug = "ForwardOptions" THEN Private(512, TRUE)
                            ELSE Private(IF Bug = "DropCap" THEN 0 ELSE parentCap, FALSE)
         /\ rpcArgs' = [cap |-> IF Bug = "DropRPCCap" THEN 0 ELSE parentCap,
                          foreign |-> Bug = "ForwardRPCOptions"]
         /\ phase' = "spawn"
         /\ UNCHANGED <<parentCap, actors, rpcWorkers>>
Spawn == /\ phase = "spawn" /\ Len(actors) < 2
         /\ actors' = Append(actors, environment)
         /\ UNCHANGED <<phase, parentCap, environment, rpcArgs, rpcWorkers>>
Restore == /\ phase = "spawn" /\ Len(actors) = 2
           /\ environment' = IF Bug = "BadRestore" THEN environment ELSE Original
           /\ phase' = "done"
           /\ UNCHANGED <<parentCap, actors, rpcArgs, rpcWorkers>>
ParentTotal == parentCap + 32
RPCSpawn == /\ phase = "spawn" /\ Len(rpcWorkers) < 2
            /\ \E measured \in {ParentTotal, 544} :
                 rpcWorkers' = Append(rpcWorkers,
                   [cap |-> rpcArgs.cap, foreign |-> rpcArgs.foreign,
                    envCap |-> 0, measured |-> measured, proved |-> FALSE, state |-> "spawned"])
            /\ UNCHANGED <<phase, parentCap, environment, actors, rpcArgs>>
RPCProof(i) == /\ rpcWorkers[i].state = "spawned"
               /\ LET matches == rpcWorkers[i].cap = parentCap
                              /\ (rpcWorkers[i].measured = ParentTotal \/ Bug = "IgnoreRPCParity")
                   IN rpcWorkers' = [rpcWorkers EXCEPT
                     ![i].state = IF parentCap = 0 \/ matches THEN "verified" ELSE "rejected",
                     ![i].proved = parentCap # 0 /\ matches]
               /\ UNCHANGED <<phase, parentCap, environment, actors, rpcArgs>>
RPCBootstrap(i) == /\ (rpcWorkers[i].state = "verified"
                       \/ (Bug = "UnprovedRPCBootstrap" /\ rpcWorkers[i].state = "spawned"))
                  /\ rpcWorkers' = [rpcWorkers EXCEPT ![i].state = "bootstrapped"]
                  /\ UNCHANGED <<phase, parentCap, environment, actors, rpcArgs>>
Next == Reset \/ Spawn \/ Restore \/ RPCSpawn
        \/ (\E i \in 1..Len(rpcWorkers) : RPCProof(i) \/ RPCBootstrap(i))
TypeOK == /\ phase \in {"capture", "spawn", "done"}
          /\ parentCap \in {0, 64, 256}
          /\ environment \in [cap : {0, 64, 256, 512}, foreign : BOOLEAN, private : BOOLEAN]
          /\ actors \in Seq([cap : {0, 64, 256, 512}, foreign : BOOLEAN, private : BOOLEAN])
          /\ Len(actors) <= 2
          /\ rpcArgs \in [cap : {0, 64, 256}, foreign : BOOLEAN]
          /\ rpcWorkers \in Seq([cap : {0, 64, 256}, foreign : BOOLEAN,
               envCap : {0}, measured : {32, 96, 288, 544}, proved : BOOLEAN,
               state : {"spawned", "verified", "rejected", "bootstrapped"}])
          /\ Len(rpcWorkers) <= 2
ResetIsolation == phase = "spawn" => environment = Private(environment.cap, FALSE)
WorkerCap == \A i \in 1..Len(actors) : actors[i] = Private(parentCap, FALSE)
ExactRestore == phase = "done" => environment = Original
RPCIsolation == \A i \in 1..Len(rpcWorkers) :
                  ~rpcWorkers[i].foreign /\ rpcWorkers[i].envCap = 0
RPCConfiguredCap == \A i \in 1..Len(rpcWorkers) : rpcWorkers[i].cap = parentCap
RPCProofBeforeBootstrap == \A i \in 1..Len(rpcWorkers) :
  (parentCap # 0 /\ rpcWorkers[i].state = "bootstrapped") => rpcWorkers[i].proved
RPCMeasuredParity == \A i \in 1..Len(rpcWorkers) :
  rpcWorkers[i].proved => rpcWorkers[i].measured = ParentTotal
Spec == Init /\ [][Next]_vars
=============================================================================
