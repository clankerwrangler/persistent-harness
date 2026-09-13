----------------------- MODULE HarnessDependencies -----------------------
EXTENDS Sequences, FiniteSets, Naturals
VARIABLES operation, stage, extras, loaded, hook, owner, summarySource,
          summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData
vars == <<operation, stage, extras, loaded, hook, owner, summarySource,
          summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData>>
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
        /\ installed = FALSE
Install == /\ stage = "new" /\ operation = "install"
           /\ stage' = "installed" /\ installed' = TRUE
           /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                          summaryWrites, externalFiles, localConfig, projection, requestScope, requestMode, sourceData, resultData>>
Uninstall == /\ ((stage = "new" /\ operation = "uninstall") \/ stage = "installed")
             /\ stage' = "removed" /\ installed' = FALSE
             /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                            summaryWrites, externalFiles, localConfig, projection, requestScope, requestMode, sourceData, resultData>>
Start == /\ stage = "new" /\ operation = "start"
         /\ stage' = "ready" /\ loaded' = <<"harness">> \o Normalize(extras)
         /\ UNCHANGED <<operation, extras, hook, owner, summarySource,
                        summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData>>
Smoke == /\ stage = "new" /\ operation = "smoke" /\ stage' = "passed"
         /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                        summaryWrites, externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData>>
Compact == /\ stage = "ready" /\ stage' = "compacting" /\ owner' = "coordinator"
           /\ summarySource' = CASE hook = "absent" -> "stock-service"
                                    [] hook = "custom" -> "active-hook"
                                    [] OTHER -> "none"
           /\ UNCHANGED <<operation, extras, loaded, hook, summaryWrites,
                          externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData>>
Finish == /\ stage = "compacting" /\ stage' = "settled" /\ owner' = "none"
          /\ summaryWrites' = IF hook = "cancel" THEN 0 ELSE 1
          /\ UNCHANGED <<operation, extras, loaded, hook, summarySource,
                         externalFiles, localConfig, projection, installed, requestScope, requestMode, sourceData, resultData>>
Project == /\ stage \in {"ready", "compacting", "settled"} /\ projection = "none"
           /\ projection' = IF requestScope = "current" /\ requestMode \in {"native", "ordinary"}
                             THEN "returned" ELSE "rejected"
           /\ resultData' = IF projection' = "returned" THEN sourceData ELSE <<>>
           /\ UNCHANGED <<operation, stage, extras, loaded, hook, owner, summarySource,
                          summaryWrites, externalFiles, localConfig, installed, requestScope, requestMode, sourceData>>
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
Spec == Init /\ [][Next]_vars
=============================================================================
