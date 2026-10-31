------------------------- MODULE KernelColdStatus -------------------------
\* Sources:
\*   src/host-handlers.mjs sha256:adff19ccf9f042327bec3dbc8789d4716149242d48b6e6927490f35062a212e1
\*   src/kernel.mjs sha256:8a14e4dcff43fa5f24ed4beab60ebf66073224de6001726fd4b80bccde0a9071

EXTENDS Naturals
CONSTANT Fault
VARIABLES capability, valid, observed, field, payload, bounded, identity
vars == <<capability, valid, observed, field, payload, bounded, identity>>
Init == /\ capability \in {0,1,2} /\ valid \in BOOLEAN
        /\ observed=FALSE /\ field="absent" /\ payload=FALSE /\ bounded=TRUE /\ identity=42
Observe == /\ ~observed /\ observed'=TRUE
           /\ field'=IF capability=1 \/ Fault="legacy" THEN "fixed" ELSE "absent"
           /\ payload'=(Fault="payload")
           /\ bounded'=(valid \/ Fault#"bounds")
           /\ identity'=IF Fault="mutation" THEN 0 ELSE identity
           /\ UNCHANGED <<capability,valid>>
Spec == Init /\ [][Observe]_vars
LegacyUnchanged == observed /\ capability#1 => field="absent"
FixedProjection == ~payload /\ bounded
NoNamespaceMutation == identity=42
=============================================================================
