---------------------- MODULE ActorCompactionSnapshots ----------------------
\* Sources:
\*   src/actor-compaction.mjs sha256:ff707741faf3ea45cb363f9866ed4cbb0309c7a76556d14ea125cae7a7963c28
\*   src/canonical-context.mjs sha256:76adbe84c8ec0e16fb8e74b4c13d62287243c1749e4adbbd97777a84cdcf1192

EXTENDS Naturals, FiniteSets
CONSTANTS Entries, Active, Pending, BadAccessor
\* Hook views have detached containers; mutable compatibility compares the full archive.
\* Registered views additionally authorize only their exact snapshot-owned getters.
\* Materialization rejects foreign/replaced getters, stale views and exhausted budgets.
\* String identities are immutable atoms; copying containers allocates no strings.
VARIABLES phase, heap, snapshot, hookView, stringStore, sourceMutation,
          hookMutation, cancel, writes, providers, getter, budgetOK, plain, rejected, arbitraryCalls
vars == <<phase, heap, snapshot, hookView, stringStore, sourceMutation,
          hookMutation, cancel, writes, providers, getter, budgetOK, plain, rejected, arbitraryCalls>>
Image == [e \in Entries |-> [nested |-> [version |-> 0], opaque |-> e,
                              pending |-> IF e = Active THEN Pending ELSE "none"]]
SameSnapshot == heap = snapshot
Init == /\ phase = "capture" /\ heap = Image /\ snapshot = Image
        /\ hookView = Image /\ stringStore = Entries \cup {Pending, "none"}
        /\ sourceMutation = FALSE /\ hookMutation = FALSE
        /\ cancel \in BOOLEAN /\ writes = 0 /\ providers = 0
        /\ getter \in {"owned", "foreign", "replaced", "forged"} /\ budgetOK \in BOOLEAN
        /\ plain = FALSE /\ rejected = FALSE /\ arbitraryCalls = 0
Capture == /\ phase = "capture" /\ phase' = "hook"
           /\ UNCHANGED <<heap, snapshot, hookView, stringStore, sourceMutation,
                          hookMutation, cancel, writes, providers, getter, budgetOK, plain, rejected, arbitraryCalls>>
MutateSource == /\ phase \in {"hook", "materialized"} /\ ~sourceMutation
                /\ \E e \in Entries : heap' = [heap EXCEPT ![e].nested.version = 1]
                /\ sourceMutation' = TRUE
                /\ UNCHANGED <<phase, snapshot, hookView, stringStore,
                               hookMutation, cancel, writes, providers, getter, budgetOK, plain, rejected, arbitraryCalls>>
MutateHook == /\ phase = "hook" /\ ~hookMutation
              /\ \E e \in Entries : hookView' = [hookView EXCEPT ![e].nested.version = 2]
              /\ hookMutation' = TRUE
              /\ UNCHANGED <<phase, heap, snapshot, stringStore, sourceMutation,
                             cancel, writes, providers, getter, budgetOK, plain, rejected, arbitraryCalls>>
Materialize == /\ phase = "hook" /\ ~cancel /\ phase' = "materialized"
               /\ plain' = ((getter = "owned" \/ BadAccessor) /\ SameSnapshot /\ budgetOK)
               /\ rejected' = ~((getter = "owned" \/ BadAccessor) /\ SameSnapshot /\ budgetOK)
               /\ arbitraryCalls' = IF getter # "owned" /\ BadAccessor THEN 1 ELSE 0
               /\ UNCHANGED <<heap, snapshot, hookView, stringStore, sourceMutation,
                    hookMutation, cancel, writes, providers, getter, budgetOK>>
Finish == /\ (phase = "materialized" \/ (phase = "hook" /\ cancel)) /\ phase' = "done"
          /\ writes' = IF SameSnapshot /\ ~cancel /\ plain THEN 1 ELSE 0
          /\ providers' = IF SameSnapshot /\ ~cancel /\ plain THEN 1 ELSE 0
          /\ UNCHANGED <<heap, snapshot, hookView, stringStore, sourceMutation,
                         hookMutation, cancel, getter, budgetOK, plain, rejected, arbitraryCalls>>
Next == Capture \/ MutateSource \/ MutateHook \/ Materialize \/ Finish
Spec == Init /\ [][Next]_vars
SnapshotIsolated == snapshot = Image
HookCannotMutateCanonical == ~sourceMutation => heap = Image
SourceCannotMutateHook == ~hookMutation => hookView = Image
InactiveMutationDetected == writes = 1 => heap = snapshot
CancelledBeforeProviderOrAppend == cancel => providers = 0 /\ writes = 0
ImmutableStringsShared == stringStore = Entries \cup {Pending, "none"}
CompleteArchive == DOMAIN heap = Entries /\ DOMAIN snapshot = Entries /\ DOMAIN hookView = Entries
BranchAndPendingPreserved == \A e \in Entries :
    heap[e].opaque = snapshot[e].opaque /\ snapshot[e].opaque = hookView[e].opaque
    /\ heap[e].pending = snapshot[e].pending /\ snapshot[e].pending = hookView[e].pending
OwnedMaterialization == plain => getter = "owned" /\ budgetOK
NoArbitraryAccessor == arbitraryCalls = 0
ValidatedBeforeAppend == writes = 1 => plain /\ ~rejected /\ getter = "owned" /\ budgetOK
=============================================================================
