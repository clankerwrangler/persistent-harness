--------------------------- MODULE VisibleOutputImages ---------------------------
EXTENDS Naturals, Sequences
CONSTANT Bug
\* Request-time image authorization. Branch changes between requests are independent;
\* bytes are reread by the canonical owner with its existing source-hash check.
\* "input" also abstracts the image projection of verified internal actor inputs.
VARIABLES source, root, active, reachable, sameOrigin, available, valid, unchanged,
          phase, response, projected, rawInput, originalInput, references, visible,
          validationDecodes, displayDecodes, hashReads
vars == <<source, root, active, reachable, sameOrigin, available, valid, unchanged,
          phase, response, projected, rawInput, originalInput, references, visible,
          validationDecodes, displayDecodes, hashReads>>
Sources == {"input", "toolImage", "toolText", "reasoning", "arguments", "custom", "file"}
PNG == [type |-> "image", data |-> "pngBytes", mimeType |-> "image/png", name |-> "caller", size |-> 999]
JPEG == [type |-> "image", data |-> "jpegBytes", mimeType |-> "image/jpeg", name |-> "caller", size |-> 999]
ImageInputs == {<<>>, <<PNG>>, <<PNG, JPEG>>, <<JPEG, PNG>>}
ByteSize(data) == IF data = "pngBytes" THEN 68 ELSE 517
DefaultName(i) == IF i = 1 THEN "Pasted image 1" ELSE "Pasted image 2"
OutputName(i) == IF i = 1 THEN "Output image 1" ELSE "Output image 2"
Init == /\ source \in Sources
        /\ root \in BOOLEAN /\ active \in BOOLEAN /\ reachable \in BOOLEAN
        /\ sameOrigin \in BOOLEAN /\ available \in BOOLEAN /\ valid \in BOOLEAN
        /\ unchanged \in BOOLEAN /\ phase = "request" /\ response = "none"
        /\ projected = FALSE /\ rawInput \in ImageInputs /\ originalInput = rawInput
        /\ references \in BOOLEAN /\ visible = <<>>
        /\ validationDecodes = 0 /\ displayDecodes = 0 /\ hashReads = 0
Eligible == source = "input" \/ (source = "toolImage" /\ root)
Allowed == sameOrigin /\ reachable /\ available /\ active /\ Eligible /\ valid /\ unchanged
Present == source = "input" \/ (source = "toolImage" /\ root /\ active /\ available /\ unchanged)
\* Fresh candidates exclude caller name/size before metadata-enabled validation.
Candidates == [i \in 1..Len(rawInput) |-> [type |-> rawInput[i].type,
              data |-> rawInput[i].data, mimeType |-> rawInput[i].mimeType]]
Normalized == [i \in 1..Len(Candidates) |-> [type |-> Candidates[i].type,
               data |-> Candidates[i].data, mimeType |-> Candidates[i].mimeType,
               name |-> IF Bug = "TrustCallerMetadata" THEN rawInput[i].name ELSE DefaultName(i),
               size |-> ByteSize(Candidates[i].data)]]
Payload(image, i) == IF references THEN [ref |-> [entryId |-> "entry", index |-> i - 1],
                                       contentHash |-> <<image.mimeType, image.data>>]
                    ELSE [data |-> image.data]
Reused == [i \in 1..Len(Normalized) |-> [type |-> "image", mimeType |-> Normalized[i].mimeType,
           name |-> IF source = "toolImage" THEN OutputName(i) ELSE Normalized[i].name,
           size |-> Normalized[i].size, payload |-> Payload(Normalized[i], i)]]
\* The old projection independently derives the fallback name and decodes for size.
Baseline == [i \in 1..Len(rawInput) |-> [type |-> "image", mimeType |-> rawInput[i].mimeType,
             name |-> IF source = "toolImage" THEN OutputName(i) ELSE DefaultName(i),
             size |-> ByteSize(rawInput[i].data), payload |-> Payload(rawInput[i], i)]]
Serve == /\ phase = "request" /\ phase' = "done"
         /\ response' = IF Allowed THEN "imageBytes" ELSE "denied"
         /\ projected' = (source = "toolImage" /\ root /\ active /\ available /\ valid /\ unchanged)
         /\ visible' = IF Present /\ (valid \/ Bug = "SkipValidation") THEN Reused ELSE <<>>
         /\ validationDecodes' = IF Present /\ Bug # "SkipValidation" THEN Len(rawInput) ELSE 0
         /\ displayDecodes' = IF Present /\ valid /\ Bug = "KeepDisplayDecode" THEN Len(rawInput) ELSE 0
         /\ hashReads' = IF Present /\ valid /\ references THEN Len(rawInput) ELSE 0
         /\ UNCHANGED <<source, root, active, reachable, sameOrigin, available, valid, unchanged,
                       rawInput, originalInput, references>>
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
MetadataEquivalent == phase = "done" /\ Present /\ valid => visible = Baseline
ValidationPreserved == phase = "done" /\ ~valid => visible = <<>>
InputValuesPreserved == rawInput = originalInput
\* Work counts abstract successful validation and hash consumption, not all processing.
ProjectionWork == phase = "done" => /\ displayDecodes = 0
                  /\ (Present /\ valid => validationDecodes = Len(rawInput))
                  /\ hashReads = IF Present /\ valid /\ references THEN Len(rawInput) ELSE 0
Spec == Init /\ [][Next]_vars
=================================================================================
