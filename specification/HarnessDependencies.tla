----------------------- MODULE HarnessDependencies -----------------------
EXTENDS Sequences, FiniteSets, Naturals
VARIABLES operation, stage, extras, loaded, hook, owner, summarySource,
          summaryWrites, externalFiles, localConfig, bridgeAbsent, installed
vars == <<operation, stage, extras, loaded, hook, owner, summarySource,
          summaryWrites, externalFiles, localConfig, bridgeAbsent, installed>>
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
        /\ externalFiles = "original" /\ localConfig = "original" /\ bridgeAbsent = TRUE
        /\ installed = FALSE
Install == /\ stage = "new" /\ operation = "install"
           /\ stage' = "installed" /\ installed' = TRUE
           /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                          summaryWrites, externalFiles, localConfig, bridgeAbsent>>
Uninstall == /\ ((stage = "new" /\ operation = "uninstall") \/ stage = "installed")
             /\ stage' = "removed" /\ installed' = FALSE
             /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                            summaryWrites, externalFiles, localConfig, bridgeAbsent>>
Start == /\ stage = "new" /\ operation = "start"
         /\ stage' = "ready" /\ loaded' = <<"harness">> \o Normalize(extras)
         /\ UNCHANGED <<operation, extras, hook, owner, summarySource,
                        summaryWrites, externalFiles, localConfig, bridgeAbsent, installed>>
Smoke == /\ stage = "new" /\ operation = "smoke" /\ stage' = "passed"
         /\ UNCHANGED <<operation, extras, loaded, hook, owner, summarySource,
                        summaryWrites, externalFiles, localConfig, bridgeAbsent, installed>>
Compact == /\ stage = "ready" /\ stage' = "compacting" /\ owner' = "coordinator"
           /\ summarySource' = CASE hook = "absent" -> "stock-service"
                                    [] hook = "custom" -> "active-hook"
                                    [] OTHER -> "none"
           /\ UNCHANGED <<operation, extras, loaded, hook, summaryWrites,
                          externalFiles, localConfig, bridgeAbsent, installed>>
Finish == /\ stage = "compacting" /\ stage' = "settled" /\ owner' = "none"
          /\ summaryWrites' = IF hook = "cancel" THEN 0 ELSE 1
          /\ UNCHANGED <<operation, extras, loaded, hook, summarySource,
                         externalFiles, localConfig, bridgeAbsent, installed>>
Next == Install \/ Uninstall \/ Start \/ Smoke \/ Compact \/ Finish
StandaloneDependencies == stage = "new" => ENABLED (Install \/ Uninstall \/ Start \/ Smoke)
OnlyExplicitExtras == loaded # <<>> => loaded = <<"harness">> \o Normalize(extras)
NoCompanionIntegration == bridgeAbsent /\ OnlyExplicitExtras
OrderedUniqueExtras == \A i, j \in DOMAIN loaded : i # j => loaded[i] # loaded[j]
OneCompactionOwner == (stage = "compacting") <=> (owner = "coordinator")
DefaultAndCustom == summarySource # "none" =>
                    (hook = "absent" /\ summarySource = "stock-service") \/
                    (hook = "custom" /\ summarySource = "active-hook")
SingleCanonicalSummary == summaryWrites \in {0, 1} /\ (hook = "cancel" => summaryWrites = 0)
PreserveExternalAndConfig == externalFiles = "original" /\ localConfig = "original"
InstallUninstallIndependent == stage = "removed" => ~installed /\ loaded = <<>>
Spec == Init /\ [][Next]_vars
=============================================================================
