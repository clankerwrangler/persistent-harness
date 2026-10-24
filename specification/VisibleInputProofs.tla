------------------------- MODULE VisibleInputProofs -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS PhysicalAuthority, CompleteInventory, ScopedRendering, ReconcileNewPending, ReadCanonicalPagePayload
VARIABLES phase, purpose, physical, inventory, receipt, parsed, selected,
          readIds, unsafe, pending, submitted, bodyKind, authorityIds
vars == <<phase, purpose, physical, inventory, receipt, parsed, selected,
          readIds, unsafe, pending, submitted, bodyKind, authorityIds>>
Inputs == {"old", "selected", "new"}
\* Version tokens stand for exact content/image/envelope matching facts, never payloads.
\* Parsed evidence chooses the same provisional ordering, IDs, and byte page.
Init == /\ phase = "ready" /\ purpose \in {"page", "delivery", "retry", "image", "family", "full", "queue"}
        /\ physical = 1 /\ inventory = 1 /\ receipt = 1 /\ parsed = 1
        /\ selected = {} /\ readIds = {} /\ unsafe = FALSE /\ pending = {"selected"} /\ submitted = {}
        /\ bodyKind \in {"canonical-id", "legacy-custom"} /\ authorityIds = {}

PageMetadataOnly == purpose = "page" /\ bodyKind = "canonical-id"
ExpectedReads == IF PageMetadataOnly THEN {} ELSE selected
Select == /\ phase = "ready" /\ phase' = "selected"
          /\ selected' = IF purpose = "full" THEN Inputs
                         ELSE IF purpose = "queue" THEN pending
                         ELSE IF purpose \in {"image", "family"} THEN {} ELSE {"selected"}
          /\ UNCHANGED <<purpose, physical, inventory, receipt, parsed, readIds, unsafe, pending, submitted, bodyKind, authorityIds>>
\* A legal same-inode rewrite is not detected by an old stored span hash.
Rewrite == /\ phase = "selected" /\ physical = 1 /\ physical' = 2
           /\ UNCHANGED <<phase, purpose, inventory, receipt, parsed, selected, readIds, unsafe, pending, submitted, bodyKind, authorityIds>>
DuplicateInactive == /\ phase = "selected" /\ inventory = 1 /\ inventory' = 2
                     /\ UNCHANGED <<phase, purpose, physical, receipt, parsed, selected, readIds, unsafe, pending, submitted, bodyKind, authorityIds>>
ReceiptChange == /\ phase = "selected" /\ receipt = 1 /\ receipt' = 2
                 /\ UNCHANGED <<phase, purpose, physical, inventory, parsed, selected, readIds, unsafe, pending, submitted, bodyKind, authorityIds>>
Verify == /\ phase = "selected" /\ phase' = "verified"
          /\ readIds' = IF ScopedRendering THEN IF ReadCanonicalPagePayload THEN selected ELSE ExpectedReads ELSE Inputs
          /\ unsafe' = (unsafe \/ (selected # {} /\ ~PageMetadataOnly /\ ~PhysicalAuthority /\ physical # parsed)
                          \/ (selected # {} /\ ~CompleteInventory /\ inventory # 1))
          /\ UNCHANGED <<purpose, physical, inventory, receipt, parsed, selected, pending, submitted, bodyKind, authorityIds>>
AdmitDuringRead == /\ purpose = "queue" /\ phase \in {"selected", "verified"} /\ "new" \notin pending
                   /\ pending' = pending \cup {"new"}
                   /\ UNCHANGED <<phase, purpose, physical, inventory, receipt, parsed, selected, readIds, unsafe, submitted, bodyKind, authorityIds>>
Rescope == /\ purpose = "queue" /\ phase = "verified" /\ ~(pending \subseteq readIds)
           /\ phase' = "ready" /\ selected' = {} /\ readIds' = {}
           /\ UNCHANGED <<purpose, physical, inventory, receipt, parsed, unsafe, pending, submitted, bodyKind, authorityIds>>
Return == /\ phase = "verified"
          /\ (purpose # "queue" \/ ~ReconcileNewPending \/ pending \subseteq readIds)
          /\ submitted' = IF purpose = "queue" THEN pending ELSE submitted
          /\ authorityIds' = IF purpose = "page" THEN {} ELSE selected
          /\ (selected = {} \/ PageMetadataOnly \/ ~PhysicalAuthority \/ physical = parsed)
          /\ (selected = {} \/ ~CompleteInventory \/ inventory = 1)
          /\ (selected = {} \/ receipt = 1)
          /\ phase' = "done"
          /\ UNCHANGED <<purpose, physical, inventory, receipt, parsed, selected, readIds, unsafe, pending, bodyKind>>
Reject == /\ phase = "verified" /\ phase' = "rejected"
          /\ UNCHANGED <<purpose, physical, inventory, receipt, parsed, selected, readIds, unsafe, pending, submitted, bodyKind, authorityIds>>
Next == AdmitDuringRead \/ Rescope \/ Select \/ Rewrite \/ DuplicateInactive \/ ReceiptChange \/ Verify \/ Return \/ Reject
Spec == Init /\ [][Next]_vars
NoCachedAuthority == ~unsafe
PageRenderNeverAuthorizesDelivery == purpose = "page" => authorityIds = {}
SubmittedScopeReconciled == submitted \subseteq readIds
UnrelatedPayloadsStayCold == phase \in {"verified", "done", "rejected"} => readIds = ExpectedReads
=============================================================================
