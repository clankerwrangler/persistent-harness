---------------------- MODULE ActorCompactionSnapshots ----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Entries, Active, Pending
\* Companion to ActorCompaction: each owner has distinct nested containers.
\* String identities are immutable atoms; copying containers allocates no strings.
VARIABLES phase, heap, snapshot, hookView, stringStore, sourceMutation,
          hookMutation, cancel, writes, providers
vars == <<phase, heap, snapshot, hookView, stringStore, sourceMutation,
          hookMutation, cancel, writes, providers>>
Image == [e \in Entries |-> [nested |-> [version |-> 0], opaque |-> e,
                              pending |-> IF e = Active THEN Pending ELSE "none"]]
SameSnapshot == heap = snapshot
Init == /\ phase = "capture" /\ heap = Image /\ snapshot = Image
        /\ hookView = Image /\ stringStore = Entries \cup {Pending, "none"}
        /\ sourceMutation = FALSE /\ hookMutation = FALSE
        /\ cancel \in BOOLEAN /\ writes = 0 /\ providers = 0
Capture == /\ phase = "capture" /\ phase' = "hook"
           /\ UNCHANGED <<heap, snapshot, hookView, stringStore, sourceMutation,
                          hookMutation, cancel, writes, providers>>
MutateSource == /\ phase = "hook" /\ ~sourceMutation
                /\ \E e \in Entries : heap' = [heap EXCEPT ![e].nested.version = 1]
                /\ sourceMutation' = TRUE
                /\ UNCHANGED <<phase, snapshot, hookView, stringStore,
                               hookMutation, cancel, writes, providers>>
MutateHook == /\ phase = "hook" /\ ~hookMutation
              /\ \E e \in Entries : hookView' = [hookView EXCEPT ![e].nested.version = 2]
              /\ hookMutation' = TRUE
              /\ UNCHANGED <<phase, heap, snapshot, stringStore, sourceMutation,
                             cancel, writes, providers>>
Finish == /\ phase = "hook" /\ phase' = "done"
          /\ writes' = IF SameSnapshot /\ ~cancel THEN 1 ELSE 0
          /\ providers' = IF SameSnapshot /\ ~cancel THEN 1 ELSE 0
          /\ UNCHANGED <<heap, snapshot, hookView, stringStore, sourceMutation,
                         hookMutation, cancel>>
Next == Capture \/ MutateSource \/ MutateHook \/ Finish
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
=============================================================================
