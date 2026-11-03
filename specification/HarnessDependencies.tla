----------------------- MODULE HarnessDependencies -----------------------
\* Sources:
\*   bin/install.mjs sha256:3c72f6cc373f7ffd971ba1fd8e57bb03f34fffaf2aaf221215170e3c41f505ff
\*   bin/package-load-smoke.mjs sha256:653a20972aacd8adacdee429bce3769145b41b7faa464627121ca3d9eccb3800
\*   src/external-pi.mjs sha256:38f8ffdff78010243eb4e5c8617ca6c0c003b03a7d46b6240b814d73d14fcbd3
\*   src/supervisor.mjs sha256:f98ce08909ebba0dbc34e8121dac397e068d8fe32d0c21c5eb4017a434b628bb
\*   src/sdk-worker.mjs sha256:ad3637bdce0be9028c01b99eb3b0c619d76473b0def01bae88de50127622ea0a
\*   src/actor-compaction.mjs sha256:ff707741faf3ea45cb363f9866ed4cbb0309c7a76556d14ea125cae7a7963c28
\*   src/actor-coordinator.mjs sha256:d33d75f88913edccec70c1cc2df0391a3e909d958f96acfd890c3b774935ae62

EXTENDS Sequences, FiniteSets, Naturals
VARIABLES operation, stage, extras, loaded, hook, owner, summarySource,
          summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData, runtimeIdentity
vars == <<operation, stage, extras, loaded, hook, owner, summarySource,
          summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData, runtimeIdentity>>
ExtraChoices == {<<>>, <<"user-a">>, <<"user-b", "user-a", "user-b", "harness">>}
RECURSIVE Normalize(_)
Normalize(xs) == IF Len(xs) = 0 THEN <<>>
                 ELSE LET prefix == Normalize(SubSeq(xs, 1, Len(xs) - 1))
                          item == xs[Len(xs)]
                      IN IF item = "harness" \/ item \in {prefix[i] : i \in DOMAIN prefix}
                         THEN prefix ELSE Append(prefix, item)
Init == /\ operation \in {"install", "start", "smoke", "uninstall"}
        /\ stage = "new" /\ extras \in ExtraChoices
        /\ loaded = <<>> /\ hook \in {"absent", "custom", "cancel"}
        /\ owner = "none" /\ summarySource = "none" /\ summaryWrites = 0
        /\ externalFiles = "original" /\ localConfig = "original" /\ projection = "none"
        /\ requestScope \in {"current", "stale", "foreign", "altered"}
        /\ requestMode \in {"native", "ordinary", "invalid"}
        /\ sourceData = <<"real-call", "real-result", "signature">> /\ resultData = <<>>
        /\ runtimeIdentity \in {"accepted", "wrong-version", "mixed-graph", "modified-bundle"}
        /\ installed = FALSE
Install == /\ stage = "new" /\ operation = "install"
           /\ stage' = "installed" /\ installed' = TRUE
           /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                          summaryWrites, externalFiles, localConfig, projection, requestScope, requestMode, sourceData, resultData, runtimeIdentity>>
Uninstall == /\ ((stage = "new" /\ operation = "uninstall") \/ stage = "installed")
             /\ stage' = "removed" /\ installed' = FALSE
             /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                            summaryWrites, externalFiles, localConfig, projection, requestScope, requestMode, sourceData, resultData, runtimeIdentity>>
Start == /\ stage = "new" /\ operation = "start"
         /\ stage' = IF runtimeIdentity = "accepted" THEN "ready" ELSE "rejected"
         /\ loaded' = IF runtimeIdentity = "accepted" THEN <<"harness">> \o Normalize(extras) ELSE <<>>
         /\ UNCHANGED <<operation, extras, hook, owner, summarySource,
                        summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData, runtimeIdentity>>
\* Package smoke imports support files/modules without loading the external SDK.
Smoke == /\ stage = "new" /\ operation = "smoke"
         /\ stage' = "passed"
         /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                        summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData, runtimeIdentity>>
Compact == /\ stage = "ready" /\ stage' = "compacting" /\ owner' = "coordinator"
           /\ summarySource' = CASE hook = "absent" -> "stock-service"
                                    [] hook = "custom" -> "active-hook"
                                    [] OTHER -> "none"
           /\ UNCHANGED <<operation, extras, loaded, hook, summaryWrites,
                          externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData, runtimeIdentity>>
Finish == /\ stage = "compacting" /\ stage' = "settled" /\ owner' = "none"
          /\ summaryWrites' = IF hook = "cancel" THEN 0 ELSE 1
          /\ UNCHANGED <<operation, extras, loaded, hook, summarySource,
                         externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData, runtimeIdentity>>
Project == /\ stage \in {"ready", "compacting", "settled"} /\ projection = "none"
           /\ projection' = IF requestScope = "current" /\ requestMode \in {"native", "ordinary"}
                             THEN "returned" ELSE "rejected"
           /\ resultData' = IF projection' = "returned" THEN sourceData ELSE <<>>
           /\ UNCHANGED <<operation, stage, extras, loaded, hook, owner, summarySource,
                          summaryWrites, externalFiles, localConfig, installed, requestScope, requestMode, sourceData, runtimeIdentity>>
Next == Install \/ Uninstall \/ Start \/ Smoke \/ Compact \/ Finish \/ Project
StandaloneDependencies == stage = "new" => ENABLED (Install \/ Uninstall \/ Start \/ Smoke)
OnlyExplicitExtras == loaded # <<>> => loaded = <<"harness">> \o Normalize(extras)
NoBundledIntegration == OnlyExplicitExtras /\ externalFiles = "original"
OrderedUniqueExtras == \A i, j \in DOMAIN loaded : i # j => loaded[i] # loaded[j]
OneCompactionOwner == (stage = "compacting") <=> (owner = "coordinator")
DefaultAndCustom == summarySource # "none" =>
                    (hook = "absent" /\ summarySource = "stock-service") \/
                    (hook = "custom" /\ summarySource = "active-hook")
SingleCanonicalSummary == summaryWrites \in {0, 1} /\ (hook = "cancel" => summaryWrites = 0)
PreserveExternalAndConfig == externalFiles = "original" /\ localConfig = "original"
InstallUninstallIndependent == stage = "removed" => ~installed /\ loaded = <<>>
ProjectionScope == projection = "returned" => requestScope = "current" /\ requestMode \in {"native", "ordinary"}
ProjectionUsesCanonical == projection = "returned" => resultData = sourceData
ProjectionReadOnly == sourceData = <<"real-call", "real-result", "signature">>
RejectedHasNoResult == projection = "rejected" => resultData = <<>>
ExactStockGraph == stage \in {"ready", "compacting", "settled"} => runtimeIdentity = "accepted"
SmokeIndependentOfRuntime == operation = "smoke" /\ stage # "new" => stage = "passed"
RejectedRuntimeNotLoaded == stage = "rejected" => loaded = <<>>
Spec == Init /\ [][Next]_vars
=============================================================================
