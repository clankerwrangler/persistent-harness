---------------------- MODULE NativeSseAccounting ----------------------
EXTENDS Naturals, Sequences, TLC
CONSTANT Fault
VARIABLES phase, request, chunks, pos, buffer, data, bufferBytes, dataBytes,
          limit, badJson, yielded, expectedYielded, error, expectedError, released
vars == <<phase, request, chunks, pos, buffer, data, bufferBytes, dataBytes,
          limit, badJson, yielded, expectedYielded, error, expectedError, released>>
Weight(t) == IF t = "W" THEN 3 ELSE 1
RECURSIVE Bytes(_)
Bytes(s) == IF Len(s) = 0 THEN 0 ELSE Weight(Head(s)) + Bytes(Tail(s))
RECURSIVE PartsBytes(_)
PartsBytes(s) == IF Len(s) = 0 THEN 0 ELSE Bytes(Head(s)) + PartsBytes(Tail(s))
Inputs == { << <<"D", "W", "CR">>, <<"LF", "LF">> >>,
            << <<"D", "a", "LF", "D", "a", "LF", "LF">> >>,
            << <<"D", "a", "LF", "LF", "a", "a", "a">> >>,
            << <<"D", "a">> >>,
            << <<"CR">>, <<"LF", "D", "a", "CR", "LF", "CR", "LF">> >>,
            << <<>>, <<"D", "W", "LF", "LF">> >> }
Delimiters(s) == {i \in 1..Len(s): s[i] \in {"CR", "LF"}}
Init == /\ phase = "begin" /\ request = 0 /\ chunks = <<>> /\ pos = 1
        /\ buffer = <<>> /\ data = <<>> /\ bufferBytes = 0 /\ dataBytes = 0
        /\ limit = 0 /\ badJson = FALSE /\ yielded = 0 /\ expectedYielded = 0
        /\ error = "" /\ expectedError = "" /\ released = FALSE
Begin == /\ phase = "begin" /\ request < 2 /\ request' = request + 1
         /\ chunks' \in Inputs /\ limit' \in {0, 1, 3, 5, 8} /\ badJson' \in BOOLEAN
         /\ phase' = "read" /\ pos' = 1 /\ buffer' = <<>> /\ data' = <<>>
         /\ bufferBytes' = 0 /\ dataBytes' = 0 /\ yielded' = 0 /\ expectedYielded' = 0
         /\ error' = "" /\ expectedError' = "" /\ released' = FALSE
Read == /\ phase = "read"
        /\ LET added == IF pos <= Len(chunks) THEN chunks[pos] ELSE <<"LF", "LF">>
           IN /\ buffer' = buffer \o added
              /\ bufferBytes' = bufferBytes + (IF Fault = "Utf8" THEN Len(added) ELSE Bytes(added))
        /\ pos' = pos + 1 /\ phase' = "line"
        /\ UNCHANGED <<request, chunks, data, dataBytes, limit, badJson, yielded, expectedYielded, error, expectedError, released>>
Line == /\ phase = "line" /\ Delimiters(buffer) # {}
        /\ LET i == CHOOSE k \in Delimiters(buffer): \A j \in Delimiters(buffer): k <= j
               held == buffer[i] = "CR" /\ i = Len(buffer) /\ pos <= Len(chunks) + 1
               delim == IF buffer[i] = "CR" /\ i < Len(buffer) /\ buffer[i+1] = "LF" THEN 2 ELSE 1
               line == SubSeq(buffer, 1, i-1)
               rest == SubSeq(buffer, i+delim, Len(buffer))
               appended == IF Len(line) > 0 /\ Head(line) = "D" THEN <<Tail(line)>> ELSE <<>>
               nextData == IF line = <<>> THEN <<>> ELSE data \o appended
               actualData == PartsBytes(nextData)
               hadData == line = <<>> /\ PartsBytes(data) > 0
               oldTotal == Bytes(buffer) + PartsBytes(data)
               rf == IF hadData /\ badJson THEN "json" ELSE ""
               f == IF Fault = "Early" /\ oldTotal > limit THEN "limit" ELSE rf
           IN IF held THEN /\ phase' = "post" /\ UNCHANGED <<buffer, data, bufferBytes, dataBytes, yielded, expectedYielded, error, expectedError>>
              ELSE /\ buffer' = rest /\ data' = nextData
                   /\ bufferBytes' = bufferBytes - Bytes(line) - (IF Fault = "Delimiter" THEN 1 ELSE delim)
                   /\ dataBytes' = IF line = <<>> THEN (IF Fault = "Reset" THEN dataBytes ELSE 0)
                                     ELSE dataBytes + PartsBytes(appended) + (IF Fault = "Join" /\ appended # <<>> /\ data # <<>> THEN 1 ELSE 0)
                   /\ yielded' = yielded + (IF hadData /\ f = "" THEN 1 ELSE 0)
                   /\ expectedYielded' = expectedYielded + (IF hadData /\ rf = "" THEN 1 ELSE 0)
                   /\ error' = f /\ expectedError' = rf
                   /\ phase' = IF f # "" \/ rf # "" THEN "finish" ELSE "check"
        /\ UNCHANGED <<request, chunks, pos, limit, badJson, released>>
Check == /\ phase = "check"
         /\ LET real == Bytes(buffer) + PartsBytes(data) > limit
                impl == (IF Fault = "Backlog" THEN 0 ELSE bufferBytes) + dataBytes > limit
            IN /\ error' = IF impl THEN "limit" ELSE ""
               /\ expectedError' = IF real THEN "limit" ELSE ""
               /\ phase' = IF impl \/ real THEN "finish" ELSE "line"
         /\ UNCHANGED <<request, chunks, pos, buffer, data, bufferBytes, dataBytes, limit, badJson, yielded, expectedYielded, released>>
NoLine == /\ phase = "line" /\ Delimiters(buffer) = {} /\ phase' = "post"
          /\ UNCHANGED <<request, chunks, pos, buffer, data, bufferBytes, dataBytes, limit, badJson, yielded, expectedYielded, error, expectedError, released>>
Post == /\ phase = "post" /\ error' = IF bufferBytes > limit THEN "limit" ELSE ""
        /\ expectedError' = IF Bytes(buffer) > limit THEN "limit" ELSE ""
        /\ phase' = IF bufferBytes > limit \/ Bytes(buffer) > limit \/ pos > Len(chunks) + 1 THEN "finish" ELSE "read"
        /\ UNCHANGED <<request, chunks, pos, buffer, data, bufferBytes, dataBytes, limit, badJson, yielded, expectedYielded, released>>
Cancel == /\ phase \in {"read", "line", "check", "post"} /\ phase' = "finish"
          /\ error' = "cancel" /\ expectedError' = "cancel"
          /\ UNCHANGED <<request, chunks, pos, buffer, data, bufferBytes, dataBytes, limit, badJson, yielded, expectedYielded, released>>
Finish == /\ phase = "finish" /\ released' = TRUE /\ phase' = "begin"
          /\ UNCHANGED <<request, chunks, pos, buffer, data, bufferBytes, dataBytes, limit, badJson, yielded, expectedYielded, error, expectedError>>
Next == Begin \/ Read \/ Line \/ Check \/ NoLine \/ Post \/ Cancel \/ Finish
BufferExact == bufferBytes = Bytes(buffer)
DataExact == dataBytes = PartsBytes(data)
FirstEffects == error = expectedError /\ yielded = expectedYielded
Released == phase = "begin" /\ request > 0 => released
Spec == Init /\ [][Next]_vars
=============================================================================
