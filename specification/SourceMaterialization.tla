-------------------- MODULE SourceMaterialization --------------------
EXTENDS Naturals, Integers, Sequences
CONSTANT BadPerMessageBudget, BadBorrow
VARIABLES sizes, depths, count, usedStrings, usedNodes, cursor, phase, rejected,
          returned, input, output, estimator, copied
vars == <<sizes,depths,count,usedStrings,usedNodes,cursor,phase,rejected,returned,input,output,estimator,copied>>
StringLimit == 4
NodeLimit == 5
DepthLimit == 3
Init == /\ sizes \in {<<>>,<<0>>,<<2>>,<<3>>,<<1,1>>,<<2,2>>,<<0,3>>}
        /\ depths \in 0..3 /\ count = Len(sizes)
        /\ usedStrings = 0 /\ usedNodes = 1 /\ cursor = 1
        /\ phase = "read" /\ rejected = FALSE /\ returned = FALSE
        /\ input = [i \in 1..count |-> 0] /\ output = <<>>
        /\ estimator = [i \in 1..count |-> 0] /\ copied = 0
Read == /\ phase = "read" /\ cursor <= count
        /\ LET strings == IF BadPerMessageBudget THEN sizes[cursor] ELSE usedStrings + 1 + sizes[cursor]
               nodes == IF BadPerMessageBudget THEN 2 ELSE usedNodes + 2
               depth == IF BadPerMessageBudget THEN depths ELSE depths + 1
               ok == strings <= StringLimit /\ nodes <= NodeLimit /\ depth <= DepthLimit
           IN /\ usedStrings' = strings /\ usedNodes' = nodes
              /\ rejected' = ~ok /\ phase' = IF ok THEN "read" ELSE "done"
              /\ output' = IF ok THEN Append(output, 0) ELSE output
              /\ cursor' = IF ok THEN cursor + 1 ELSE cursor
              /\ copied' = IF ok THEN copied + 1 ELSE copied
        /\ UNCHANGED <<sizes,depths,count,returned,input,estimator>>
Publish == /\ phase = "read" /\ cursor > count
           /\ phase' = "mutate" /\ returned' = TRUE
           /\ UNCHANGED <<sizes,depths,count,usedStrings,usedNodes,cursor,rejected,input,output,estimator,copied>>
Mutate == /\ phase = "mutate" /\ phase' = "done"
          /\ output' = IF count = 0 THEN output ELSE [output EXCEPT ![1] = 1]
          /\ estimator' = IF count = 0 \/ ~BadBorrow THEN estimator ELSE [estimator EXCEPT ![1] = 1]
          /\ UNCHANGED <<sizes,depths,count,usedStrings,usedNodes,cursor,rejected,returned,input,copied>>
Next == Read \/ Publish \/ Mutate
Spec == Init /\ [][Next]_vars
RECURSIVE SumSizes(_)
SumSizes(s) == IF Len(s) = 0 THEN 0 ELSE Head(s) + SumSizes(Tail(s))
TotalStrings == IF count = 0 THEN 0 ELSE count + SumSizes(sizes)
WholeBudget == returned => TotalStrings <= StringLimit /\ 1 + 2*count <= NodeLimit /\ (count = 0 \/ depths + 1 <= DepthLimit)
InputUnchanged == \A i \in 1..count : input[i] = 0
EstimatorDetached == \A i \in 1..count : estimator[i] = 0
OneFinalCopy == returned => copied = count
=============================================================================
