-------------------------- MODULE SnapshotSaveScope --------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Names
\* manifestOK covers bounded decoding/version and candidate shape/path/size/hash.
\* oldAuditOK represents prior stats/skipped/checkpoint validity, not save input.
VARIABLES stage, manifestOK, oldAuditOK, selected, matching, candidates, remaining,
          linked, verified, rewritten, checks, priorReads, restoreOK, restored
vars == <<stage, manifestOK, oldAuditOK, selected, matching, candidates, remaining,
          linked, verified, rewritten, checks, priorReads, restoreOK, restored>>
Init == /\ stage = "metadata"
        /\ manifestOK \in BOOLEAN
        /\ oldAuditOK \in BOOLEAN
        /\ selected \in SUBSET Names
        /\ matching \in SUBSET selected
        /\ candidates = {} /\ remaining = selected
        /\ linked = {} /\ verified = {} /\ rewritten = {} /\ checks = {}
        /\ priorReads = 0 /\ restoreOK \in BOOLEAN /\ restored = FALSE
Metadata == /\ stage = "metadata" /\ stage' = "save"
            /\ candidates' = IF manifestOK THEN matching ELSE {}
            /\ UNCHANGED <<manifestOK, oldAuditOK, selected, matching, remaining, linked,
                           verified, rewritten, checks, priorReads, restoreOK, restored>>
Write(n) == /\ stage = "save" /\ n \in remaining /\ n \notin candidates
            /\ rewritten' = rewritten \cup {n} /\ remaining' = remaining \ {n}
            /\ UNCHANGED <<stage, manifestOK, oldAuditOK, selected, matching, candidates, linked,
                           verified, checks, priorReads, restoreOK, restored>>
\* The path can change after metadata lookup. Only the linked destination's
\* no-follow regular-file/size/digest check against CURRENT bytes admits reuse.
Reuse(n) == /\ stage = "save" /\ n \in remaining /\ n \in candidates
            /\ \E destination \in {"current", "corrupt", "nonregular", "missing"}:
                 /\ linked' = linked \cup {n}
                 /\ checks' = checks \cup {n}
                 /\ verified' = IF destination = "current" THEN verified \cup {n} ELSE verified
                 /\ rewritten' = IF destination = "current" THEN rewritten ELSE rewritten \cup {n}
            /\ remaining' = remaining \ {n}
            /\ UNCHANGED <<stage, manifestOK, oldAuditOK, selected, matching, candidates,
                           priorReads, restoreOK, restored>>
Publish == /\ stage = "save" /\ remaining = {} /\ stage' = "published"
           /\ UNCHANGED <<manifestOK, oldAuditOK, selected, matching, candidates, remaining, linked,
                          verified, rewritten, checks, priorReads, restoreOK, restored>>
\* Restore still needs complete descriptor-bound validation, not candidates.
Restore == /\ stage = "published" /\ stage' = "done" /\ restored' = restoreOK
           /\ UNCHANGED <<manifestOK, oldAuditOK, selected, matching, candidates, remaining, linked,
                          verified, rewritten, checks, priorReads, restoreOK>>
Next == Metadata \/ (\E n \in Names : Write(n) \/ Reuse(n)) \/ Publish \/ Restore
CurrentBytesOnly == stage \in {"published", "done"} => selected = verified \cup rewritten
EveryReuseVerified == verified \subseteq checks /\ verified \subseteq linked
NoUnselectedChecks == checks \subseteq candidates /\ candidates \subseteq selected
NoPriorPayloadAudit == priorReads = 0
InvalidManifestCannotReuse == ~manifestOK => verified = {}
RestoreRequiresFullValidation == restored => restoreOK
OldAuditDoesNotGateSave == stage = "metadata" => ENABLED Metadata
Spec == Init /\ [][Next]_vars
=============================================================================
