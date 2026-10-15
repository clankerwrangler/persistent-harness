--------------------------- MODULE VisibleOutputImages ---------------------------
EXTENDS Naturals
\* Request-time image authorization. Branch changes between requests are independent;
\* bytes are reread by the canonical owner with its existing source-hash check.
VARIABLES source, root, active, reachable, sameOrigin, available, valid, unchanged,
          phase, response, projected
vars == <<source, root, active, reachable, sameOrigin, available, valid, unchanged,
          phase, response, projected>>
Sources == {"input", "toolImage", "toolText", "reasoning", "arguments", "custom", "file"}
Init == /\ source \in Sources
        /\ root \in BOOLEAN /\ active \in BOOLEAN /\ reachable \in BOOLEAN
        /\ sameOrigin \in BOOLEAN /\ available \in BOOLEAN /\ valid \in BOOLEAN
        /\ unchanged \in BOOLEAN /\ phase = "request" /\ response = "none"
        /\ projected = FALSE
Eligible == source = "input" \/ (source = "toolImage" /\ root)
Allowed == sameOrigin /\ reachable /\ available /\ active /\ Eligible /\ valid /\ unchanged
Serve == /\ phase = "request" /\ phase' = "done"
         /\ response' = IF Allowed THEN "imageBytes" ELSE "denied"
         /\ projected' = (source = "toolImage" /\ root /\ active /\ available /\ valid /\ unchanged)
         /\ UNCHANGED <<source, root, active, reachable, sameOrigin, available, valid, unchanged>>
Next == Serve
Boundary == response = "imageBytes" => sameOrigin /\ reachable /\ available /\ active
OnlyImages == response = "imageBytes" => source \in {"input", "toolImage"}
RootOutputsOnly == response = "imageBytes" /\ source = "toolImage" => root
BoundedCanonicalBytes == response = "imageBytes" => valid /\ unchanged
InputsPreserved == phase = "done" /\ source = "input" /\ sameOrigin /\ reachable
                   /\ available /\ active /\ valid /\ unchanged => response = "imageBytes"
OutputsDelivered == phase = "done" /\ source = "toolImage" /\ root /\ sameOrigin
                    /\ reachable /\ available /\ active /\ valid /\ unchanged => response = "imageBytes"
OutputPresentation == projected <=> (phase = "done" /\ source = "toolImage" /\ root
                     /\ active /\ available /\ valid /\ unchanged)
Spec == Init /\ [][Next]_vars
=================================================================================
