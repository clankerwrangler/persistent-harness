------------------------- MODULE KernelColdStatus -------------------------
\* Sources:
\*   src/host-handlers.mjs sha256:adc15b760150ca2e1883014523c1f922acaa8673a1cdeac487e98f2615ee06e6
\*   src/kernel.mjs sha256:feb1bec8dc4e3d47d0f11956acacea17cdfac0d91fa853c785f0f050754d06e2

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
