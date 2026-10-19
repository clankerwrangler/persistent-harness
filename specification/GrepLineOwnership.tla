--------------------------- MODULE GrepLineOwnership ---------------------------
EXTENDS Integers, Sequences, TLC
CONSTANT Fault
VARIABLES first, second, split, memory, pending, pendingAlias, raw, borrowed,
          completedCopies, phase, result
vars == <<first, second, split, memory, pending, pendingAlias, raw, borrowed,
          completedCopies, phase, result>>
Samples == {<<0>>, <<1>>, <<2>>, <<0, 1>>, <<1, 0>>}
Outcome(bytes) == IF 2 \in {bytes[i] : i \in 1..Len(bytes)}
                  THEN <<"binary", <<>>>> ELSE <<"text", bytes>>
Init ==
  /\ first \in Samples /\ second \in Samples /\ split \in BOOLEAN
  /\ memory = first /\ pending = <<>> /\ pendingAlias = FALSE
  /\ raw = <<>> /\ borrowed = FALSE /\ completedCopies = 0
  /\ phase = "first" /\ result = <<>>
First ==
  /\ phase = "first"
  /\ IF split
     THEN /\ pending' = first /\ pendingAlias' = (Fault = "borrow")
          /\ phase' = "advance" /\ UNCHANGED <<raw, borrowed, completedCopies>>
     ELSE /\ raw' = memory /\ borrowed' = TRUE
          /\ completedCopies' = IF Fault = "copy" THEN 1 ELSE 0
          /\ phase' = IF Fault = "defer" THEN "late" ELSE "consume"
          /\ UNCHANGED <<pending, pendingAlias>>
  /\ UNCHANGED <<first, second, split, memory, result>>
Advance ==
  /\ phase \in {"advance", "late"} /\ memory' = second
  /\ phase' = IF phase = "late" THEN "consume" ELSE "assemble"
  /\ UNCHANGED <<first, second, split, pending, pendingAlias, raw, borrowed,
                 completedCopies, result>>
Assemble ==
  /\ phase = "assemble"
  /\ raw' = (IF pendingAlias THEN memory ELSE pending) \o memory
  /\ borrowed' = FALSE /\ completedCopies' = IF Fault = "copy" THEN 1 ELSE 0
  /\ phase' = "consume"
  /\ UNCHANGED <<first, second, split, memory, pending, pendingAlias, result>>
Consume ==
  /\ phase = "consume" /\ result' = Outcome(IF borrowed THEN memory ELSE raw)
  /\ phase' = "done"
  /\ UNCHANGED <<first, second, split, memory, pending, pendingAlias, raw,
                 borrowed, completedCopies>>
Next == First \/ Advance \/ Assemble \/ Consume
Spec == Init /\ [][Next]_vars
NoCompletedCopies == completedCopies = 0
OutputExact == phase = "done" => result = Outcome(IF split THEN first \o second ELSE first)
(* A chunk is stable through synchronous decode, matching and string projection.
   Only an incomplete line crosses the next asynchronous read and needs a copy.
   Token 2 represents a decode/binary rejection; concrete UTF-8, truncation,
   regular expressions, filesystem fences and worker cleanup remain JS checks. *)
=============================================================================
