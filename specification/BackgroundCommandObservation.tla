---------------- MODULE BackgroundCommandObservation ----------------
EXTENDS Naturals, Sequences, TLC
CONSTANT Fault
VARIABLES call, input, phase, encoded, observations, result, history
vars == <<call, input, phase, encoded, observations, result, history>>
Inputs == 0..3
\* 0 is a failed proc read; 1 is short; 2/3 are distinct long commands.
Expected(x) == IF x = 0 THEN 0 ELSE IF x = 1 THEN 1 ELSE x + 10
Init == /\ call = 0 /\ input \in Inputs /\ phase = "read"
        /\ encoded = 0 /\ observations = 0 /\ result = 0 /\ history = <<>>
Read == /\ phase = "read"
        /\ IF input = 0 THEN
              /\ result' = 0 /\ phase' = "done"
              /\ UNCHANGED <<encoded, observations>>
           ELSE
              /\ encoded' = IF Fault = "Retain" /\ call > 0 THEN encoded ELSE input
              /\ observations' = observations + 1 /\ phase' = "limit"
              /\ UNCHANGED result
        /\ UNCHANGED <<call, input, history>>
Limit == /\ phase = "limit"
         /\ observations' = observations + IF Fault = "Reread" /\ input > 1 THEN 1 ELSE 0
         /\ result' = IF Fault = "Truncate" /\ input > 1 THEN encoded ELSE Expected(encoded)
         /\ phase' = "done"
         /\ UNCHANGED <<call, input, encoded, history>>
NextCall == /\ phase = "done" /\ call = 0
            /\ call' = 1 /\ input' \in Inputs /\ phase' = "read"
            /\ observations' = 0 /\ result' = 0
            /\ history' = Append(history, <<input, result>>)
            /\ UNCHANGED encoded
Next == Read \/ Limit \/ NextCall
AtMostOnce == observations <= 1
FreshResult == phase = "done" => result = Expected(input)
HistoryCorrect == \A i \in 1..Len(history): history[i][2] = Expected(history[i][1])
=============================================================================
