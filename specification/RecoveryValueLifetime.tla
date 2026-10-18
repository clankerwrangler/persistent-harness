-------------------- MODULE RecoveryValueLifetime --------------------
EXTENDS Naturals, TLC
CONSTANT BadReleaseEarly, BadRetainReady
VARIABLES stage, validated, temporary, restored, failed
vars == <<stage,validated,temporary,restored,failed>>
Init == /\ stage = "validate" /\ validated = FALSE /\ temporary = FALSE /\ restored = FALSE /\ failed = FALSE
Validate == /\ stage = "validate" /\ stage' = "restore"
            /\ validated' = TRUE /\ temporary' = ~BadReleaseEarly
            /\ UNCHANGED <<restored,failed>>
Restore == /\ stage = "restore" /\ stage' = "release"
           /\ restored' = validated /\ temporary /\ failed' \in BOOLEAN
           /\ UNCHANGED <<validated,temporary>>
Release == /\ stage = "release" /\ stage' = "ready"
           /\ temporary' = BadRetainReady /\ UNCHANGED <<validated,restored,failed>>
Next == Validate \/ Restore \/ Release
Spec == Init /\ [][Next]_vars
BoundBytesThroughRestore == stage = "restore" => validated /\ temporary
ExactRestore == stage = "ready" => restored
NoReadyTemporary == stage = "ready" => ~temporary
=============================================================================
