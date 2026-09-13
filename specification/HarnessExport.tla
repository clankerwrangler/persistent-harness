---------------- MODULE HarnessExport ----------------
EXTENDS FiniteSets, Sequences
Core == {"supervisor", "worker", "coordinator", "protocol", "python", "provider", "history", "compaction"}
Skills == {"agent-message", "rlm", "kernel", "operations", "cron", "session-history", "files", "shell", "background"}
Forbidden == {"webui", "base-pi", "pi-patch", "companion-upstream", "companion-delta", "private-state", "host-skills", "git-history"}
VARIABLES stage, files, stock, catalog, validated, oldPreserved
vars == <<stage,files,stock,catalog,validated,oldPreserved>>
Init == /\ stage="inspect" /\ files={} /\ stock=FALSE /\ catalog="none" /\ validated=FALSE /\ oldPreserved=FALSE
PreserveOld == /\ stage="inspect" /\ oldPreserved'=TRUE /\ stage'="empty"
               /\ UNCHANGED <<files,stock,catalog,validated>>
Copy == /\ stage="empty" /\ oldPreserved /\ files'=Core \cup Skills \cup {"docs","models","tests"}
        /\ stage'="copied" /\ UNCHANGED <<stock,catalog,validated,oldPreserved>>
ConfigurePi == /\ stage="copied" /\ ~stock /\ stock'=TRUE
               /\ UNCHANGED <<stage,files,catalog,validated,oldPreserved>>
Catalog(c) == /\ stage="copied" /\ c \in {"bundled","explicit-complete"} /\ catalog'=c
              /\ UNCHANGED <<stage,files,stock,validated,oldPreserved>>
Validate == /\ stage="copied" /\ stock /\ catalog#"none"
            /\ Core \subseteq files /\ Skills \subseteq files /\ validated'=TRUE /\ stage'="ready"
            /\ UNCHANGED <<files,stock,catalog,oldPreserved>>
Next == PreserveOld \/ Copy \/ ConfigurePi \/ Validate \/ (\E c \in {"bundled","explicit-complete"}: Catalog(c))
NoUpstreamOrPrivateFiles == files \cap Forbidden={}
FullHarnessPreserved == stage \in {"copied","ready"} => Core \cup Skills \subseteq files
ExplicitExternalDependencies == validated => stock
CompleteCatalog == validated => catalog \in {"bundled","explicit-complete"}
PriorEvidencePreserved == stage#"inspect" => oldPreserved
NoPartialReady == stage="ready" => validated
Spec == Init /\ [][Next]_vars
==========================================================
