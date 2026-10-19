----------------------------- MODULE HostFileEdit -----------------------------
EXTENDS Integers, Sequences, TLC
CONSTANT Fault
VARIABLES inputs, call, phase, parts, scans, retained, built, results
vars == <<inputs, call, phase, parts, scans, retained, built, results>>
NoParts == [version |-> 0, matches |-> 0]
Result(kind, n) == [kind |-> kind, version |-> call, matches |-> n]
Expected(s, i) ==
  [kind |-> IF ~s.utf8 THEN "utf8"
           ELSE IF s.matches = 0 THEN "missing"
           ELSE IF ~s.all /\ s.matches # 1 THEN "ambiguous"
           ELSE IF ~s.fits THEN "limit" ELSE "ok",
   version |-> i,
   matches |-> IF s.utf8 /\ s.matches > 0 /\ (s.all \/ s.matches = 1) /\ s.fits
               THEN s.matches ELSE 0]
Init ==
  /\ inputs \in [1..2 -> [matches : 0..2, utf8 : BOOLEAN, all : BOOLEAN, fits : BOOLEAN]]
  /\ call = 1 /\ phase = "decode" /\ parts = NoParts /\ scans = 0
  /\ retained = NoParts /\ built = Result("none", 0) /\ results = <<>>
Finish(value) ==
  /\ results' = Append(results, value)
  /\ call' = IF call = 1 THEN 2 ELSE call
  /\ phase' = IF call = 1 THEN "decode" ELSE "done"
  /\ parts' = NoParts /\ scans' = 0
  /\ UNCHANGED <<inputs, retained, built>>
Decode ==
  /\ phase = "decode"
  /\ IF ~inputs[call].utf8 THEN Finish(Result("utf8", 0))
     ELSE /\ phase' = "split"
          /\ UNCHANGED <<inputs, call, parts, scans, retained, built, results>>
Split ==
  /\ phase = "split"
  /\ LET reuse == Fault = "retain" /\ retained.version # 0
         current == [version |-> call, matches |-> inputs[call].matches]
     IN /\ parts' = IF reuse THEN retained ELSE current
        /\ scans' = IF reuse THEN 0 ELSE 1
        /\ retained' = IF Fault = "retain" THEN parts' ELSE retained
  /\ phase' = "guard"
  /\ UNCHANGED <<inputs, call, built, results>>
Guard ==
  /\ phase = "guard"
  /\ IF parts.matches = 0 THEN Finish(Result("missing", 0))
     ELSE IF ~inputs[call].all /\ parts.matches # 1 /\ Fault # "skip"
          THEN Finish(Result("ambiguous", 0))
     ELSE /\ phase' = "build"
          /\ UNCHANGED <<inputs, call, parts, scans, retained, built, results>>
Build ==
  /\ phase = "build"
  /\ scans' = scans + (IF Fault = "reread" THEN 1 ELSE 0)
  /\ built' = IF inputs[call].fits THEN Result("ok", parts.matches) ELSE Result("limit", 0)
  /\ phase' = "finish"
  /\ UNCHANGED <<inputs, call, parts, retained, results>>
Complete == /\ phase = "finish" /\ Finish(built)
Next == Decode \/ Split \/ Guard \/ Build \/ Complete
Spec == Init /\ [][Next]_vars
Once == scans <= 1
Fresh == phase \in {"guard", "build", "finish"} =>
           parts = [version |-> call, matches |-> inputs[call].matches]
FirstErrorsAndOutput == \A i \in 1..Len(results): results[i] = Expected(inputs[i], i)
(* Immutable primitive text and literal split/join semantics are assumed here.
   This finite model checks one local partition, unchanged error precedence,
   and fresh subsequent operations. Filesystem atomicity/revalidation/durability
   remain outside this optimization and are exercised by existing host tests. *)
=============================================================================
