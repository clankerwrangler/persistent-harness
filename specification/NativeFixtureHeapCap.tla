------------------------- MODULE NativeFixtureHeapCap -------------------------
EXTENDS Naturals, Sequences, TLC
CONSTANT Bug
VARIABLES phase, parentCap, environment, actors
vars == <<phase, parentCap, environment, actors>>
Original == [cap |-> 512, foreign |-> TRUE, private |-> FALSE]
Private(cap, foreign) == [cap |-> cap, foreign |-> foreign, private |-> TRUE]
Init == /\ phase = "capture"
        /\ parentCap \in {0, 64, 256}
        /\ environment = Original
        /\ actors = <<>>
Reset == /\ phase = "capture"
         /\ environment' = IF Bug = "ForwardOptions" THEN Private(512, TRUE)
                            ELSE Private(IF Bug = "DropCap" THEN 0 ELSE parentCap, FALSE)
         /\ phase' = "spawn"
         /\ UNCHANGED <<parentCap, actors>>
Spawn == /\ phase = "spawn" /\ Len(actors) < 2
         /\ actors' = Append(actors, environment)
         /\ UNCHANGED <<phase, parentCap, environment>>
Restore == /\ phase = "spawn" /\ Len(actors) = 2
           /\ environment' = IF Bug = "BadRestore" THEN environment ELSE Original
           /\ phase' = "done"
           /\ UNCHANGED <<parentCap, actors>>
Next == Reset \/ Spawn \/ Restore
TypeOK == /\ phase \in {"capture", "spawn", "done"}
          /\ parentCap \in {0, 64, 256}
          /\ environment \in [cap : {0, 64, 256, 512}, foreign : BOOLEAN, private : BOOLEAN]
          /\ actors \in Seq([cap : {0, 64, 256, 512}, foreign : BOOLEAN, private : BOOLEAN])
          /\ Len(actors) <= 2
ResetIsolation == phase = "spawn" => environment = Private(environment.cap, FALSE)
WorkerCap == \A i \in 1..Len(actors) : actors[i] = Private(parentCap, FALSE)
ExactRestore == phase = "done" => environment = Original
Spec == Init /\ [][Next]_vars
=============================================================================
