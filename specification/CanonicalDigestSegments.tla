------------------------- MODULE CanonicalDigestSegments -------------------------
EXTENDS Integers, Sequences, TLC
CONSTANT Fault
(* The unchanged recursive walk emits typed primitive frames and literal container
   frames. Payloads are complete UTF-8 encodings; JSON text/coercion remains intact.
   Only the final ASCII semicolon moves to a separate SHA-256 update. *)
Frames == {
 [prefix |-> <<115,58>>, body |-> <<34,97,34>>, kind |-> "string"],
 [prefix |-> <<115,58>>, body |-> <<34,195,169,34>>, kind |-> "unicode"],
 [prefix |-> <<115,58>>, body |-> <<34,92,117,100,56,48,48,34>>, kind |-> "escaped"],
 [prefix |-> <<110,58>>, body |-> <<45,48>>, kind |-> "negative-zero"],
 [prefix |-> <<110,58>>, body |-> <<48>>, kind |-> "zero"],
 [prefix |-> <<117,58>>, body |-> <<117,110,100,101,102,105,110,101,100>>, kind |-> "undefined"],
 [prefix |-> <<98,58>>, body |-> <<116,114,117,101>>, kind |-> "boolean"],
 [prefix |-> <<111,58>>, body |-> <<110,117,108,108>>, kind |-> "null"]}
VARIABLES input, index, phase, expected, output, concatenated
vars == <<input, index, phase, expected, output, concatenated>>
Init == /\ input \in Frames \cup {<<>>} \cup (Frames \X Frames)
        /\ index = 1 /\ phase = "body" /\ expected = <<>> /\ output = <<>> /\ concatenated = 0
(* Single records and pairs use the same emitted-frame sequence. *)
Stream == IF input = <<>> THEN <<>> ELSE IF input \in Frames THEN <<input>> ELSE input
ActualBody(frame) == IF Fault = "Undefined" /\ frame.kind = "undefined" THEN <<>>
                     ELSE IF Fault = "Zero" /\ frame.kind = "negative-zero" THEN <<48>> ELSE frame.body
Body == /\ phase = "body" /\ index <= Len(Stream)
        /\ expected' = expected \o Stream[index].prefix \o Stream[index].body \o <<59>>
        /\ output' = output \o Stream[index].prefix \o ActualBody(Stream[index])
        /\ phase' = "delimiter"
        /\ concatenated' = concatenated + IF Fault = "Copy" THEN Len(Stream[index].body) + 1 ELSE 0
        /\ UNCHANGED <<input, index>>
Delimiter == /\ phase = "delimiter"
             /\ output' = IF Fault = "Delimiter" THEN output ELSE output \o <<59>>
             /\ phase' = "body" /\ index' = index + 1
             /\ UNCHANGED <<input, expected, concatenated>>
Next == Body \/ Delimiter
BoundaryBytes == phase = "body" => output = expected
NoCombinedPayload == concatenated = 0
Spec == Init /\ [][Next]_vars
=============================================================================
