---------------- MODULE ProgrammaticEntry ----------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES input, advert, fence, official, targetBundle, sdkOnly, aux, exportsOk,
          fallback, phase, calls, pending, result, answers, imports
vars == <<input,advert,fence,official,targetBundle,sdkOnly,aux,exportsOk,fallback,
          phase,calls,pending,result,answers,imports>>
Inputs == {"root","bundle","programmatic","directory","command","private","none","root-at-bundle"}
Adverts == {"absent","exact","pattern","conditional","exact-invalid-pattern-valid",
            "null","missing","nonfile","escape","unsupported"}
ValidAdvert == advert \in {"exact","pattern","conditional"}
Effective == IF input="root-at-bundle" THEN "root" ELSE IF input="none" /\ fallback THEN "command" ELSE input
GraphOk == fence="valid"
RawChoice == CASE Effective="root" -> "root"
              [] Effective="bundle" -> IF official THEN "bundle" ELSE "error"
              [] Effective="programmatic" -> IF ValidAdvert THEN "programmatic" ELSE "error"
              [] Effective \in {"directory","command"} ->
                   IF ValidAdvert THEN "programmatic" ELSE IF advert="absent" THEN "root" ELSE "error"
              [] OTHER -> "error"
Guarded(choice) == IF choice="programmatic" /\ targetBundle THEN IF official THEN "bundle" ELSE "error" ELSE choice
Expected == IF ~GraphOk \/ ~exportsOk \/ (~sdkOnly /\ ~aux) THEN "error" ELSE Guarded(RawChoice)
FaultChoice == CASE Fault="root-bundle-shadow" /\ input="root-at-bundle" -> IF official THEN "bundle" ELSE "error"
                [] Fault="root-preference" /\ Effective="root" /\ ValidAdvert -> "programmatic"
                [] Fault="invalid-fallback" /\ Effective \in {"directory","command"} /\ ~ValidAdvert -> "root"
                [] Fault="exact-pattern" /\ advert="exact-invalid-pattern-valid" /\ Effective="directory" -> "programmatic"
                [] Fault="private-file" /\ Effective="private" -> "programmatic"
                [] Fault="bundle-hash" /\ Effective="bundle" -> "bundle"
                [] OTHER -> RawChoice
Actual == IF (~GraphOk /\ Fault#"graph-fence") \/ ~exportsOk \/ (~sdkOnly /\ ~aux)
             \/ (sdkOnly /\ ~aux /\ Fault="sdk-aux") THEN "error" ELSE IF Fault="programmatic-bundle-alias" THEN FaultChoice ELSE Guarded(FaultChoice)
Init == /\ input \in Inputs /\ advert \in Adverts
        /\ fence \in {"valid","identity","version","dependency","graph","shared-ai"}
        /\ official \in BOOLEAN /\ targetBundle \in BOOLEAN /\ sdkOnly \in BOOLEAN /\ aux \in BOOLEAN
        /\ exportsOk \in BOOLEAN /\ fallback \in BOOLEAN
        /\ phase="cold" /\ calls={} /\ pending={} /\ result="none"
        /\ answers=[i \in {1,2} |-> "none"] /\ imports=0
Start == /\ phase="cold" /\ phase'="pending" /\ pending'={1} /\ calls'={1}
         /\ imports'=imports+1 /\ UNCHANGED <<result,answers>>
         /\ UNCHANGED <<input,advert,fence,official,targetBundle,sdkOnly,aux,exportsOk,fallback>>
Attach == /\ phase="pending" /\ 2 \notin calls /\ calls'=calls \cup {2}
          /\ pending'=pending \cup {2} /\ UNCHANGED <<phase,result,answers,imports>>
          /\ UNCHANGED <<input,advert,fence,official,targetBundle,sdkOnly,aux,exportsOk,fallback>>
Settle == /\ phase="pending" /\ phase'="settled" /\ result'=Actual
          /\ answers'=[i \in {1,2} |-> IF i \in pending THEN Actual ELSE "none"]
          /\ pending'={} /\ UNCHANGED <<calls,imports>>
          /\ UNCHANGED <<input,advert,fence,official,targetBundle,sdkOnly,aux,exportsOk,fallback>>
LateCall == /\ phase="settled" /\ 2 \notin calls /\ calls'=calls \cup {2}
            /\ answers'=[answers EXCEPT ![2]=result]
            /\ imports'=IF Fault="retry-rejected" /\ result="error" THEN imports+1 ELSE imports
            /\ UNCHANGED <<phase,result,pending>>
            /\ UNCHANGED <<input,advert,fence,official,targetBundle,sdkOnly,aux,exportsOk,fallback>>
Next == Start \/ Attach \/ Settle \/ LateCall
Spec == Init /\ [][Next]_vars
Selection == phase="settled" => result=Expected
ExplicitRoot == phase="settled" /\ GraphOk /\ exportsOk /\ (sdkOnly \/ aux) /\ Effective="root" => result="root"
InvalidRejected == phase="settled" /\ ~ValidAdvert /\ advert#"absent" /\ Effective \in {"directory","command","programmatic"} => result="error"
Fences == phase="settled" /\ ~GraphOk => result="error"
OfficialBundle == phase="settled" /\ Effective="bundle" /\ ~official => result="error"
SdkOnlyIndependent == phase="settled" /\ sdkOnly /\ GraphOk /\ exportsOk => result=Guarded(RawChoice)
OneFirstUse == imports <= 1
SharedSettlement == \A i \in calls : answers[i]#"none" => answers[i]=result
RetainedRejection == phase="settled" /\ result="error" => imports=1
============================================================
