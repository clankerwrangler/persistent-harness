-------------------- MODULE RecoveryValueLifetime --------------------
\* Sources:
\*   python-runtime/kernel.py sha256:d4aa99006f90d531b546686f6208dc48f77609f4faa00dabb91e7a81f80bc361
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
