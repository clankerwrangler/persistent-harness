----------------------- MODULE CanonicalContextBudget -----------------------
EXTENDS Integers, Sequences
CONSTANT StringLimit, MaxViewLimit, NodeLimit, DepthLimit, EntryLimit
VARIABLES records, nodes, depth, plain, delta, signatureValid,
          viewStrings, metadataStrings, viewNodes, viewDepth,
          phase, original, detached, helper, rejected, returned, configuration, environment, laterEnvironment, captured
vars == <<records, nodes, depth, plain, delta, signatureValid,
          viewStrings, metadataStrings, viewNodes, viewDepth,
          phase, original, detached, helper, rejected, returned, configuration, environment, laterEnvironment, captured>>
WithinArchive(s) == Len(s) <= EntryLimit /\ nodes <= NodeLimit /\ depth <= DepthLimit
                    /\ plain /\ \A i \in DOMAIN s : s[i] <= StringLimit
OverlayOK == signatureValid /\ detached[1] + delta <= StringLimit
\* -1 represents an absent setting; 0 and out-of-range values represent invalid configuration.
ConfigOK(value) == value = -1 \/ value \in StringLimit..MaxViewLimit
Resolved(value) == IF value = -1 THEN StringLimit ELSE value
ViewOK == viewStrings + metadataStrings <= captured
          /\ viewNodes <= NodeLimit /\ viewDepth <= DepthLimit
Init == /\ records \in {<<0,0>>, <<2,2>>, <<1,3>>, <<2,2,2>>, <<0,0,0,0>>}
        /\ nodes \in {Len(records) + 1, NodeLimit + 1}
        /\ depth \in {DepthLimit, DepthLimit + 1}
        /\ plain \in BOOLEAN /\ delta \in 0..3 /\ signatureValid \in BOOLEAN
        /\ viewStrings \in {0, 1, 2, 3, MaxViewLimit, MaxViewLimit + 1} /\ metadataStrings \in 0..3
        /\ viewNodes \in {1, NodeLimit + 1} /\ viewDepth \in {DepthLimit, DepthLimit + 1}
        /\ configuration \in {-1, 0, StringLimit - 1, StringLimit, 3 * StringLimit, MaxViewLimit, MaxViewLimit + 1}
        /\ environment = configuration /\ laterEnvironment \in {0, MaxViewLimit} /\ captured = 0
        /\ phase = "configuration" /\ original = records /\ detached = <<>> /\ helper = <<>>
        /\ rejected = FALSE /\ returned = FALSE
Configure == /\ phase = "configuration"
             /\ rejected' = ~ConfigOK(environment)
             /\ captured' = IF ConfigOK(environment) THEN Resolved(environment) ELSE 0
             /\ phase' = IF ConfigOK(environment) THEN "archive" ELSE "done"
             /\ UNCHANGED <<records, nodes, depth, plain, delta, signatureValid,
                  viewStrings, metadataStrings, viewNodes, viewDepth, original, detached,
                  helper, returned, configuration, environment, laterEnvironment>>
ArchiveCopy == /\ phase = "archive"
               /\ rejected' = ~WithinArchive(records)
               /\ detached' = IF WithinArchive(records) THEN records ELSE <<>>
               /\ phase' = IF WithinArchive(records) THEN "overlay" ELSE "done"
               /\ UNCHANGED <<records, nodes, depth, plain, delta, signatureValid,
                    viewStrings, metadataStrings, viewNodes, viewDepth, original, helper, returned, configuration, environment, laterEnvironment, captured>>
Overlay == /\ phase = "overlay"
           /\ rejected' = ~OverlayOK
           /\ detached' = IF OverlayOK THEN [detached EXCEPT ![1] = @ + delta] ELSE detached
           /\ phase' = IF OverlayOK THEN "helper" ELSE "done"
           /\ UNCHANGED <<records, nodes, depth, plain, delta, signatureValid,
                viewStrings, metadataStrings, viewNodes, viewDepth, original, helper, returned, configuration, environment, laterEnvironment, captured>>
HelperCopy == /\ phase = "helper"
              /\ environment' = laterEnvironment
              /\ rejected' = ~WithinArchive(detached)
              /\ helper' = IF WithinArchive(detached) THEN detached ELSE <<>>
              /\ phase' = IF WithinArchive(detached) THEN "view" ELSE "done"
              /\ UNCHANGED <<records, nodes, depth, plain, delta, signatureValid,
                   viewStrings, metadataStrings, viewNodes, viewDepth, original, detached, returned, configuration, laterEnvironment, captured>>
Materialize == /\ phase = "view"
               /\ rejected' = ~ViewOK /\ returned' = ViewOK /\ phase' = "done"
               /\ UNCHANGED <<records, nodes, depth, plain, delta, signatureValid,
                    viewStrings, metadataStrings, viewNodes, viewDepth, original, detached, helper, configuration, environment, laterEnvironment, captured>>
Next == Configure \/ ArchiveCopy \/ Overlay \/ HelperCopy \/ Materialize
Spec == Init /\ [][Next]_vars
InputUnchanged == records = original
ArchiveRecordScope == phase = "overlay" => detached = records /\ WithinArchive(detached)
OverlayBounded == phase \in {"helper", "view"} => WithinArchive(detached)
NoPartialOverlay == phase = "done" /\ ~signatureValid => detached = records \/ detached = <<>>
HelperDetachedImage == phase = "view" => helper = detached /\ WithinArchive(helper)
FinalViewBounded == returned => ViewOK /\ ~rejected /\ captured \in StringLimit..MaxViewLimit
NoLifetimeStringLimit == phase = "done" /\ ConfigOK(configuration) /\ WithinArchive(records) /\ signatureValid
                        /\ records[1] + delta <= StringLimit /\ ViewOK => returned
CapturedConfiguration == phase # "configuration" /\ ConfigOK(configuration) => captured = Resolved(configuration)
InvalidConfiguration == phase # "configuration" /\ ~ConfigOK(configuration) => rejected /\ ~returned /\ detached = <<>>
=============================================================================
