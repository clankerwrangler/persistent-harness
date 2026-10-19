------------------------ MODULE NamespaceRecoveryLatch ------------------------
EXTENDS Naturals
CONSTANT Bug
VARIABLES kernel, recoveryKernel, epoch, visible, reference, proven, step, last
vars == <<kernel, recoveryKernel, epoch, visible, reference, proven, step, last>>
Init == /\ kernel \in 0..1 /\ recoveryKernel \in 0..1
        /\ epoch = 0 /\ visible = FALSE /\ reference = FALSE /\ proven = 2
        /\ step = 0 /\ last = [work |-> FALSE, wanted |-> FALSE,
                              actual |-> "ok", expected |-> "ok",
                              sanitize |-> TRUE, required |-> TRUE]
Same == kernel = recoveryKernel
Kinds == {"missing", "partial", "full", "reportError", "payloadError", "undefined", "sanitizerError"}
Outcome(read, kind) == IF read /\ kind = "reportError" THEN "reportError"
                       ELSE IF read /\ kind \in {"payloadError", "undefined"} THEN kind
                       ELSE IF kind = "sanitizerError" THEN "sanitizerError" ELSE "ok"
Observe(kind) ==
  LET wanted == Same /\ ~reference
      read == (Same \/ Bug = "Kernel") /\ (~visible \/ Bug = "Reread") /\ Bug # "Premature"
      actual == Outcome(read, kind)
      expected == Outcome(wanted, kind)
      sanitize == actual \in {"ok", "sanitizerError"} /\ ~(Bug = "Sanitizer" /\ visible)
  IN /\ step < 4 /\ kind \in Kinds
     /\ visible' = (visible \/ (read /\ kind = "full"))
     /\ reference' = (reference \/ (wanted /\ kind = "full"))
     /\ proven' = IF read /\ kind = "full" THEN epoch ELSE proven
     /\ last' = [work |-> read, wanted |-> wanted, actual |-> actual, expected |-> expected,
                 sanitize |-> sanitize, required |-> expected \in {"ok", "sanitizerError"}]
     /\ step' = step + 1
     /\ UNCHANGED <<kernel, recoveryKernel, epoch>>
\* Session/result/replacement recovery always creates a fresh unresolved object.
Reset(nextKernel) == /\ step < 4 /\ epoch = 0 /\ nextKernel \in 0..1
                     /\ epoch' = 1 /\ kernel' = nextKernel /\ recoveryKernel' = nextKernel
                     /\ visible' = IF Bug = "Reset" THEN visible ELSE FALSE
                     /\ reference' = FALSE /\ proven' = 2 /\ step' = step + 1
                     /\ UNCHANGED last
\* A kernel can change before reconciliation creates its replacement report.
SwitchKernel == /\ step < 4 /\ kernel' = 1-kernel /\ step' = step+1
                /\ UNCHANGED <<recoveryKernel, epoch, visible, reference, proven, last>>
Next == (\E kind \in Kinds: Observe(kind)) \/ (\E nextKernel \in 0..1: Reset(nextKernel)) \/ SwitchKernel
Spec == Init /\ [][Next]_vars
Admission == visible = reference
FreshRecovery == visible => proven = epoch
RequiredWork == last.work = last.wanted
FirstErrors == last.actual = last.expected
Sanitizer == last.sanitize = last.required
=============================================================================
