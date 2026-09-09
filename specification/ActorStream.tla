--------------------------- MODULE ActorStream ---------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
VARIABLES native, closed, proved, terminal, canceled, cursor, planned,
          committed, admitted, frozen, amendment, conflict, textIds, nativeStored
vars == <<native,closed,proved,terminal,canceled,cursor,planned,committed,
          admitted,frozen,amendment,conflict,textIds,nativeStored>>
Calls == {2,3}
Range(s) == {s[i]: i \in DOMAIN s}
Init == /\ native \in SUBSET Calls /\ closed = {} /\ proved = {}
        /\ terminal = "open" /\ canceled = FALSE /\ cursor = 0
        /\ planned = <<>> /\ committed = <<>> /\ admitted = <<>>
        /\ frozen = <<>> /\ amendment = FALSE /\ conflict = FALSE
        /\ nativeStored = {}
        /\ textIds = <<"text0","text3">>
Close(i) == /\ terminal = "open" /\ ~canceled /\ i \notin closed
            /\ closed' = closed \cup {i}
            /\ UNCHANGED <<native,proved,terminal,canceled,cursor,planned,
                 committed,admitted,frozen,amendment,conflict,textIds,nativeStored>>
Proof(i) == /\ terminal = "open" /\ ~canceled /\ i \in native \ proved
            /\ proved' = proved \cup {i} /\ closed' = closed \cup {i}
            /\ UNCHANGED <<native,terminal,canceled,cursor,planned,committed,
                 admitted,frozen,amendment,conflict,textIds,nativeStored>>
Finish(t) == /\ terminal = "open" /\ ~canceled /\ planned = <<>>
             /\ terminal' = t
             /\ closed' = IF t = "success" THEN 1..4 ELSE closed
             /\ UNCHANGED <<native,proved,canceled,cursor,planned,committed,
                  admitted,frozen,amendment,conflict,textIds,nativeStored>>
Prefix(k) == /\ ~canceled /\ planned = <<>> /\ terminal = "open"
             /\ k \in Calls /\ k > cursor
             /\ \A i \in (cursor+1)..k : i \in closed /\ (i \in Calls => i \in proved)
             /\ planned' = [i \in 1..(k-cursor) |-> cursor+i]
             /\ UNCHANGED <<native,closed,proved,terminal,canceled,cursor,
                  committed,admitted,frozen,amendment,conflict,textIds,nativeStored>>
Final == /\ ~canceled /\ planned = <<>> /\ terminal \in {"success","failed","length"}
         /\ cursor < 4 /\ planned' = [i \in 1..(4-cursor) |-> cursor+i]
         /\ UNCHANGED <<native,closed,proved,terminal,canceled,cursor,
              committed,admitted,frozen,amendment,conflict,textIds,nativeStored>>
Ack == /\ ~canceled /\ planned # <<>>
       /\ committed' = committed \o planned /\ frozen' = committed \o planned
       /\ admitted' = admitted \o SelectSeq(planned, LAMBDA i:
            i \in Calls /\ terminal \in {"open","success"})
       /\ nativeStored' = nativeStored \cup (IF terminal \in {"open","success"} THEN Range(planned) \cap proved ELSE {})
       /\ cursor' = cursor+Len(planned) /\ planned' = <<>>
       /\ UNCHANGED <<native,closed,proved,terminal,canceled,amendment,conflict,textIds>>
Cancel == /\ ~canceled /\ canceled' = TRUE /\ planned' = <<>>
          /\ UNCHANGED <<native,closed,proved,terminal,cursor,committed,
               admitted,frozen,amendment,conflict,textIds,nativeStored>>
Encrypt == /\ terminal # "open" /\ 1 \in Range(committed)
           /\ ~amendment /\ ~conflict /\ amendment' = TRUE
           /\ UNCHANGED <<native,closed,proved,terminal,canceled,cursor,planned,
                committed,admitted,frozen,conflict,textIds,nativeStored>>
Conflict == /\ terminal # "open" /\ ~conflict /\ conflict' = TRUE
            /\ UNCHANGED <<native,closed,proved,terminal,canceled,cursor,planned,
                 committed,admitted,frozen,amendment,textIds,nativeStored>>
BaseNext == (\E i \in 1..4: Close(i)) \/ (\E i \in Calls: Proof(i))
        \/ (\E t \in {"success","failed","length"}: Finish(t))
        \/ (\E k \in Calls: Prefix(k)) \/ Final \/ Ack \/ Cancel \/ Encrypt \/ Conflict
SourcePrefix == committed = [i \in 1..cursor |-> i]
Immutable == frozen = committed
NoDuplicateAdmission == Cardinality(Range(admitted)) = Len(admitted)
SourceOrder == \A i,j \in DOMAIN admitted: i < j => admitted[i] < admitted[j]
NativePrefixOnly == terminal = "open" => Range(admitted) \subseteq proved
ClosedPrefix == terminal = "open" => Range(committed) \subseteq closed
OrdinaryBarrier == terminal = "open" => \A i \in Range(committed) \cap Calls: i \in native
Cancellation == canceled => planned = <<>>
ExactAmendmentTarget == amendment => 1 \in Range(committed)
StableTextIdentity == textIds = <<"text0","text3">>
MarkerRequiresReceipt == nativeStored \subseteq proved
MarkerRequiresAdmission == nativeStored \subseteq Range(admitted)

\* Separate scenario: transform validation happens before a caller can append.
CONSTANT Scenario
VARIABLES hookKind, hookChange, hookPhase, hookStatus, hookCalls,
          hookNative, hookWritten, hookValidated, hookCanceled, hookSourceStatus
hookVars == <<hookKind,hookChange,hookPhase,hookStatus,hookCalls,
              hookNative,hookWritten,hookValidated,hookCanceled,hookSourceStatus>>
OriginalCalls == << <<2,0>>, <<3,0>> >>
Changes == {"same","text","usage","errorText","args","callID","extraCall",
            "removeCall","reorder","reasoning","coreID","provenance"}
ProtectedChanges == {"reasoning","coreID","provenance"}
Transformed(c) == CASE c = "args" -> << <<2,1>>, <<3,0>> >>
                   [] c = "callID" -> << <<4,0>>, <<3,0>> >>
                   [] c = "extraCall" -> << <<2,0>>, <<3,0>>, <<4,0>> >>
                   [] c = "removeCall" -> << <<3,0>> >>
                   [] c = "reorder" -> << <<3,0>>, <<2,0>> >>
                   [] OTHER -> OriginalCalls
ExactReceipts(s) == {i \in DOMAIN s: s[i] \in Range(OriginalCalls)}
ValidHook == hookChange \notin ProtectedChanges
             /\ (hookSourceStatus = "success" \/ hookStatus # "success")
             /\ IF hookKind = "prefix"
                 THEN hookChange \in {"same","text","usage","errorText"} /\ hookStatus = "success"
                 ELSE hookChange # "reorder"
HookInit == /\ IF Scenario = "stream" THEN hookKind = "prefix" ELSE hookKind \in {"prefix","final"}
            /\ hookSourceStatus \in (IF hookKind = "prefix" THEN {"success"} ELSE {"success","failed","length","deferred"}) /\ hookChange = "same"
            /\ hookPhase = "planned" /\ hookStatus = hookSourceStatus
            /\ hookCalls = OriginalCalls /\ hookNative = {}
            /\ hookWritten = <<>> /\ hookValidated = FALSE /\ hookCanceled = FALSE
Transform(c,s) == /\ hookPhase = "planned" /\ ~hookCanceled
                  /\ hookChange' = c /\ hookStatus' = s /\ hookCalls' = Transformed(c)
                  /\ hookPhase' = "candidate"
                  /\ UNCHANGED <<hookKind,hookNative,hookWritten,hookValidated,hookCanceled,hookSourceStatus>>
ValidateHook == /\ hookPhase = "candidate" /\ ~hookCanceled
                /\ hookPhase' = IF ValidHook THEN "prepared" ELSE "rejected"
                /\ hookValidated' = ValidHook
                /\ hookNative' = IF ValidHook /\ hookStatus = "success" THEN ExactReceipts(hookCalls) ELSE {}
                /\ UNCHANGED <<hookKind,hookChange,hookStatus,hookCalls,hookWritten,hookCanceled,hookSourceStatus>>
WriteHook == /\ hookPhase = "prepared" /\ hookValidated /\ ~hookCanceled
             /\ hookPhase' = "written" /\ hookWritten' = hookCalls
             /\ UNCHANGED <<hookKind,hookChange,hookStatus,hookCalls,hookNative,hookValidated,hookCanceled,hookSourceStatus>>
CancelHook == /\ ~hookCanceled /\ hookCanceled' = TRUE
              /\ UNCHANGED <<hookKind,hookChange,hookPhase,hookStatus,hookCalls,hookNative,hookWritten,hookValidated,hookSourceStatus>>
HookNext == (\E c \in Changes, s \in {"success","failed","length","deferred"}: Transform(c,s))
            \/ ValidateHook \/ WriteHook \/ CancelHook
BeforeWriteValidation == hookWritten # <<>> => hookValidated
RejectedNeverWritten == hookPhase = "rejected" => hookWritten = <<>>
ProtectedPrefix == hookWritten # <<>> /\ hookKind = "prefix" => hookCalls = OriginalCalls
ExactReceiptAfterTransform == \A i \in hookNative: hookCalls[i] \in Range(OriginalCalls)
FailedOrLengthNoNative == hookStatus # "success" => hookNative = {}
NoSourceFailureUpgrade == hookWritten # <<>> /\ hookSourceStatus # "success" => hookStatus # "success"
AcceptedMessageWritten == hookWritten # <<>> => hookWritten = hookCalls
HookNativeSourceOrder == \A i,j \in hookNative: i < j => hookCalls[i][1] < hookCalls[j][1]
Next == IF Scenario = "stream" THEN BaseNext /\ UNCHANGED hookVars ELSE HookNext /\ UNCHANGED vars
Spec == Init /\ HookInit /\ [][Next]_<<vars,hookVars>>

=============================================================================
