-------------------- MODULE KernelLaunchValidation --------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Fault
VARIABLE s
vars == <<s>>
Init == s = [generation |-> 1, phase |-> "select", attempt |-> 1,
             active |-> FALSE, retired |-> TRUE, proof |-> 0, cached |-> FALSE,
             managed |-> TRUE, importsOK |-> TRUE, pinsOK |-> TRUE,
             lock |-> FALSE, consent |-> FALSE, completion |-> FALSE,
             ready |-> FALSE, waiters |-> 1, kind |-> "none", badClassification |-> FALSE, badFresh |-> FALSE,
             badPins |-> FALSE, badFallback |-> FALSE, badExpose |-> FALSE,
             badRetire |-> FALSE, badCompletion |-> FALSE]
Join == /\ s.waiters=1 /\ s.phase # "done"
        /\ s'=[s EXCEPT !.waiters=2]
Lock == /\ s.phase="select" /\ s.attempt=3 /\ ~s.lock
        /\ s'=[s EXCEPT !.lock=TRUE]
Consent == /\ s.phase="select" /\ s.attempt=4 /\ s.lock /\ ~s.consent
           /\ s'=[s EXCEPT !.consent=TRUE]
Spawn(m,i,p,k) ==
  /\ s.phase="select" /\ s.attempt<=4
  /\ (s.attempt<3 \/ s.lock) /\ (s.attempt<4 \/ s.consent)
  /\ s'=[s EXCEPT !.phase="launch", !.kind=k, !.active=TRUE, !.retired=FALSE,
                  !.managed=m, !.importsOK=i, !.pinsOK=p, !.proof=0,
                  !.badRetire=(s.badRetire \/ ~s.retired)]
HostLaunch ==
  /\ s.phase="launch"
  /\ LET configFailure == s.kind \in {"cwd","ambiguous"}
         wrong == configFailure /\ Fault=s.kind
     IN s'=[s EXCEPT !.phase=IF wrong \/ s.kind="executable" THEN "rejected"
                            ELSE IF configFailure THEN "startup-failed" ELSE "imports",
                    !.badClassification=(s.badClassification \/ wrong)]
Metadata ==
  /\ s.phase="metadata"
  /\ LET wrong == s.kind="metadata" /\ Fault="metadata"
     IN s'=[s EXCEPT !.phase=IF wrong THEN "rejected"
                            ELSE IF s.kind="metadata" THEN "startup-failed" ELSE "validated",
                    !.badClassification=(s.badClassification \/ wrong)]
Imports ==
  /\ s.phase="imports"
  /\ LET fresh == ~(Fault="fresh" /\ s.cached)
         accept == (IF fresh THEN s.importsOK ELSE TRUE)
                   /\ (~s.managed \/ s.pinsOK \/ Fault="pins")
     IN s'=[s EXCEPT !.phase=IF accept THEN "metadata" ELSE "rejected",
                    !.proof=IF fresh /\ accept THEN s.generation ELSE 0,
                    !.cached=s.cached \/ accept,
                    !.badFresh=(s.badFresh \/ (accept /\ ~fresh)),
                    !.badPins=(s.badPins \/ (accept /\ s.managed /\ ~s.pinsOK))]
Validated ==
  /\ s.phase="validated"
  /\ s'=[s EXCEPT !.phase="restore",
                  !.completion=s.completion \/ s.attempt=4,
                  !.badCompletion=(s.badCompletion \/ (s.attempt=4 /\
                    (s.proof#s.generation \/ ~s.importsOK \/ (s.managed /\ ~s.pinsOK))))]
PublicationFailure == /\ s.phase="validated" /\ s.attempt=4
                      /\ s'=[s EXCEPT !.phase="startup-failed"]
RestoreOK == /\ s.phase="restore" /\ s'=[s EXCEPT !.phase="final-ready"]
RestoreFailure == /\ s.phase="restore"
                  /\ s'=[s EXCEPT !.phase=IF Fault="fallback" THEN "rejected" ELSE "startup-failed",
                                  !.badFallback=(s.badFallback \/ Fault="fallback")]
Expose == /\ (s.phase="final-ready" \/ (Fault="expose" /\ s.phase="validated"))
          /\ s'=[s EXCEPT !.ready=TRUE, !.phase="ready",
                          !.badExpose=(s.badExpose \/ s.phase#"final-ready")]
Retire == /\ s.phase \in {"rejected","startup-failed","ready"}
          /\ s'=[s EXCEPT !.active=FALSE, !.retired=TRUE, !.ready=FALSE,
                          !.phase=CASE s.phase="rejected" -> "retry"
                                  [] s.phase="ready" -> "replace"
                                  [] OTHER -> "done"]
Retry == /\ s.phase="retry"
         /\ s'=[s EXCEPT !.attempt=s.attempt+1,
                         !.phase=IF s.attempt<4 THEN "select" ELSE "done"]
Replacement == /\ s.phase="replace" /\ s.generation=1
               /\ s'=[s EXCEPT !.generation=2, !.attempt=1, !.phase="select",
                               !.lock=FALSE, !.consent=FALSE, !.proof=0]
Next == Join \/ Lock \/ Consent \/ (\E m,i,p \in BOOLEAN, k \in {"none","cwd","ambiguous","executable","metadata"}: Spawn(m,i,p,k))
        \/ HostLaunch \/ Imports \/ Metadata \/ Validated \/ PublicationFailure \/ RestoreOK \/ RestoreFailure
        \/ Expose \/ Retire \/ Retry \/ Replacement
OnlyRuntimeRepair == ~s.badClassification
FreshProcess == ~s.badFresh
ManagedPins == ~s.badPins
NoRestoreFallback == ~s.badFallback
FinalReadyOnly == ~s.badExpose /\ (s.ready => s.phase="ready")
RetireBeforeSuccessor == ~s.badRetire
EnvironmentCompletion == ~s.badCompletion
LockAndConsent == s.attempt=4 /\ s.active => s.lock /\ s.consent
CoalescedStart == s.waiters \in 1..2 /\ s.active \in BOOLEAN
Spec == Init /\ [][Next]_vars
=============================================================================
