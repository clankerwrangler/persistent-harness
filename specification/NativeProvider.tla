--------------------------- MODULE NativeProvider ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Items
VARIABLES phase, flight, transport, request, sentModel, model, advertised,
          returned, rawComplete, rawIds, receipts, seen, retries, attempts,
          reconnectSafe, terminal, ordinary, sent, created, unknown, retired, rawKind, successfulResponses, successfulItems, itemResponse, itemStatus, reasoningOriginal, reasoningFinal, failureKind
vars == <<phase, flight, transport, request, sentModel, model, advertised,
          returned, rawComplete, rawIds, receipts, seen, retries, attempts,
          reconnectSafe, terminal, ordinary, sent, created, unknown, retired, rawKind, successfulResponses, successfulItems, itemResponse, itemStatus, reasoningOriginal, reasoningFinal, failureKind>>
Init == /\ phase = "idle" /\ flight = 0 /\ transport \in {"sse", "ws"}
        /\ request = 0 /\ model \in {"enabled", "ordinary"} /\ sentModel = "none"
        /\ advertised = {} /\ returned = {} /\ rawComplete = {} /\ rawIds = {}
        /\ receipts = {} /\ seen = FALSE /\ retries = 0 /\ attempts = 0
        /\ reconnectSafe = FALSE /\ terminal = FALSE /\ ordinary = {}
        /\ sent = FALSE /\ created = FALSE /\ unknown = FALSE /\ retired = FALSE
        /\ rawKind = [i \in Items |-> "none"]
        /\ successfulResponses = {} /\ successfulItems = {}
        /\ itemResponse = [i \in Items |-> 0] /\ itemStatus = [i \in Items |-> "none"]
        /\ reasoningOriginal = [body |-> "none", cipher |-> "absent"] /\ reasoningFinal = [body |-> "none", cipher |-> "absent"] /\ failureKind = "none"
Begin == /\ phase = "idle" /\ request < 2 /\ phase' = "preparing" /\ flight' = 1
         /\ request' = request + 1 /\ terminal' = FALSE /\ seen' = FALSE
         /\ sent' = FALSE /\ created' = FALSE /\ unknown' = FALSE /\ retired' = FALSE
         /\ rawKind' = [i \in Items |-> "none"]
         /\ itemResponse' = [i \in Items |-> 0] /\ itemStatus' = [i \in Items |-> "none"]
         /\ reasoningOriginal' = [body |-> "none", cipher |-> "absent"] /\ reasoningFinal' = [body |-> "none", cipher |-> "absent"] /\ failureKind' = "none"
         /\ retries' = 0 /\ attempts' = 0 /\ reconnectSafe' = FALSE
         /\ advertised' = {} /\ returned' = {} /\ rawComplete' = {} /\ rawIds' = {}
         /\ receipts' = {} /\ ordinary' = {} /\ sentModel' = "none"
         /\ UNCHANGED <<transport, model, successfulResponses, successfulItems>>
Send == /\ phase = "preparing" /\ (retries = 0 \/ retired) /\ phase' = "wire" /\ sentModel' = model
        /\ sent' = TRUE /\ retired' = FALSE
        /\ advertised' \subseteq Items /\ attempts' = attempts + 1
        /\ UNCHANGED <<flight, transport, request, model, returned, rawComplete,
              rawIds, receipts, seen, retries, reconnectSafe, terminal, ordinary, created, unknown, rawKind, successfulResponses, successfulItems, itemResponse, itemStatus, reasoningOriginal, reasoningFinal, failureKind>>
Partial == /\ phase = "wire" /\ seen' = TRUE /\ created' = TRUE
           /\ UNCHANGED <<phase, flight, transport, request, sentModel, model,
              advertised, returned, rawComplete, rawIds, receipts, retries,
              attempts, reconnectSafe, terminal, ordinary, sent, unknown, retired, rawKind, successfulResponses, successfulItems, itemResponse, itemStatus, reasoningOriginal, reasoningFinal, failureKind>>
Complete(i, native, ids, source, status) ==
        /\ phase = "wire" /\ i \notin rawComplete /\ seen' = TRUE
        /\ rawComplete' = rawComplete \cup {i}
        /\ rawKind' = [rawKind EXCEPT ![i] = source]
        /\ itemResponse' = [itemResponse EXCEPT ![i] = request]
        /\ itemStatus' = [itemStatus EXCEPT ![i] = status]
        /\ returned' = IF native THEN returned \cup {i} ELSE returned
        /\ rawIds' = IF ids THEN rawIds \cup {i} ELSE rawIds
        /\ receipts' = IF native /\ ids /\ i \in advertised /\ sentModel = "enabled"
                        THEN receipts \cup {i} ELSE receipts
        /\ ordinary' = IF native /\ ids /\ i \in advertised /\ sentModel = "enabled"
                        THEN ordinary ELSE ordinary \cup {i}
        /\ UNCHANGED <<phase, flight, transport, request, sentModel, model,
              advertised, retries, attempts, reconnectSafe, terminal, sent, created, unknown, retired, successfulResponses, successfulItems, reasoningOriginal, reasoningFinal, failureKind>>
RejectedContinuation ==
        /\ phase = "wire" /\ transport = "ws" /\ ~seen /\ retries = 0
        /\ sent' = FALSE /\ retired' = TRUE /\ phase' = "preparing" /\ retries' = 1 /\ reconnectSafe' = TRUE
        /\ UNCHANGED <<flight, transport, request, sentModel, model, advertised,
              returned, rawComplete, rawIds, receipts, seen, attempts, terminal, ordinary, created, unknown, rawKind, successfulResponses, successfulItems, itemResponse, itemStatus, reasoningOriginal, reasoningFinal, failureKind>>
End == /\ phase = "wire" /\ phase' = "idle" /\ flight' = 0 /\ terminal' = TRUE
       /\ successfulResponses' = successfulResponses \cup {request}
       /\ successfulItems' = successfulItems \cup rawComplete
       /\ UNCHANGED <<transport, request, sentModel, model, advertised, returned,
              rawComplete, rawIds, receipts, seen, retries, attempts, reconnectSafe, ordinary, sent, created, unknown, retired, rawKind, itemResponse, itemStatus, reasoningOriginal, reasoningFinal, failureKind>>
CancelOrError(kind) ==
       /\ phase \in {"preparing", "wire"} /\ phase' = "idle" /\ flight' = 0
       /\ unknown' = sent /\ retired' = TRUE /\ failureKind' = kind
       /\ UNCHANGED <<transport, request, sentModel, model, advertised, returned,
              rawComplete, rawIds, receipts, seen, retries, attempts, reconnectSafe, terminal, ordinary, sent, created, rawKind, successfulResponses, successfulItems, itemResponse, itemStatus, reasoningOriginal, reasoningFinal>>
Close == /\ phase # "closed" /\ phase' = "closed" /\ flight' = 0
         /\ unknown' = (sent /\ ~terminal) /\ retired' = TRUE
         /\ UNCHANGED <<transport, request, sentModel, model, advertised, returned,
              rawComplete, rawIds, receipts, seen, retries, attempts, reconnectSafe, terminal, ordinary, sent, created, rawKind, successfulResponses, successfulItems, itemResponse, itemStatus, reasoningOriginal, reasoningFinal, failureKind>>
\* Cached successful identities survive Begin. Old envelopes never reach the parser,
\* including a terminal envelope that otherwise could end the next request.
CreatedFrame(r) == /\ phase = "wire"
                   /\ IF r \in successfulResponses THEN UNCHANGED vars
                       ELSE IF r = request THEN Partial ELSE CancelOrError("other")
TerminalFrame(r) == /\ phase = "wire"
                    /\ IF r \in successfulResponses THEN UNCHANGED vars
                        ELSE IF r = request THEN End ELSE CancelOrError("other")
CompleteFrame(i, native, ids, source, r, status) ==
        /\ phase = "wire"
        /\ IF r \in successfulResponses \/ i \in successfulItems THEN UNCHANGED vars
            ELSE IF r # request \/ status = "in_progress" THEN CancelOrError("other")
            ELSE Complete(i, native, ids, source, status)
ReasoningComplete(body, cipher) ==
        /\ phase = "wire" /\ reasoningOriginal.body = "none"
        /\ reasoningOriginal' = [body |-> body, cipher |-> cipher]
        /\ reasoningFinal' = reasoningOriginal'
        /\ UNCHANGED <<phase, flight, transport, request, sentModel, model, advertised,
              returned, rawComplete, rawIds, receipts, seen, retries, attempts,
              reconnectSafe, terminal, ordinary, sent, created, unknown, retired, rawKind,
              successfulResponses, successfulItems, itemResponse, itemStatus, failureKind>>
ReasoningRepeat(body, cipher) ==
        /\ phase = "wire" /\ reasoningOriginal.body # "none"
        /\ IF body = reasoningFinal.body /\
                (cipher = reasoningFinal.cipher \/
                  (reasoningFinal.cipher \in {"absent", "null", "empty"} /\ cipher \in {"cipher_a", "cipher_b"}))
            THEN /\ reasoningFinal' = [body |-> body, cipher |-> cipher]
                 /\ UNCHANGED <<phase, flight, transport, request, sentModel, model, advertised,
                      returned, rawComplete, rawIds, receipts, seen, retries, attempts,
                      reconnectSafe, terminal, ordinary, sent, created, unknown, retired, rawKind,
                      successfulResponses, successfulItems, itemResponse, itemStatus,
                      reasoningOriginal, failureKind>>
            ELSE CancelOrError("reasoning_conflict")
RawEOF == /\ phase = "wire" /\ transport = "sse" /\ CancelOrError("stream_incomplete")
Next == Begin \/ Send \/ RejectedContinuation \/ CancelOrError("other") \/ Close \/ RawEOF
        \/ (\E b \in {"body_a", "body_b"}, c \in {"absent", "null", "empty", "cipher_a", "cipher_b"}: ReasoningComplete(b,c) \/ ReasoningRepeat(b,c))
        \/ (\E r \in 1..2: CreatedFrame(r) \/ TerminalFrame(r))
        \/ (\E i \in Items, n \in BOOLEAN, ids \in BOOLEAN,
                s \in {"item_done", "terminal_complete"}, r \in 1..2,
                status \in {"absent", "completed", "in_progress"}: CompleteFrame(i,n,ids,s,r,status))
TypeOK == /\ phase \in {"idle", "preparing", "wire", "closed"} /\ flight \in 0..1
          /\ request \in 0..2 /\ attempts \in 0..2 /\ retries \in 0..1
          /\ receipts \subseteq Items /\ ordinary \subseteq Items
OneFlight == (phase \in {"preparing", "wire"}) <=> flight = 1
RawProvenance == receipts \subseteq rawComplete \cap returned \cap rawIds \cap advertised
MatchingModel == receipts # {} => sentModel = "enabled"
OrdinaryPreserved == rawComplete = receipts \cup ordinary /\ receipts \cap ordinary = {}
NoUncertainRetry == attempts = 2 => reconnectSafe /\ transport = "ws"
UnknownFenced == unknown => retired /\ flight = 0
LateFramesCannotAdmit == retired /\ unknown => phase \in {"idle", "closed"}
CompleteSourceRetained == \A i \in receipts: rawKind[i] \in {"item_done", "terminal_complete"}
SuccessfulGenerationFenced == phase \in {"preparing", "wire"} =>
    request \notin successfulResponses /\ rawComplete \cap successfulItems = {}
AllCompleteStatusesValid == \A i \in rawComplete: itemStatus[i] \in {"absent", "completed"}
CompletionBelongsToRequest == \A i \in rawComplete: itemResponse[i] = request
\* Stock Codex body policy is independent of model reasoning support/effort.
\* Public payload hooks remain explicit owner transformations outside this default.
CodexBody(reasoning, choice) ==
    [include |-> {"reasoning.encrypted_content"},
     toolChoice |-> IF choice = "default" THEN "auto" ELSE choice]
CodexCiphertextRequest == \A r \in {"false", "off", "mapped_high"},
    c \in {"default", "auto", "none", "required"}:
      "reasoning.encrypted_content" \in CodexBody(r,c).include
CodexToolChoiceDefault == \A r \in {"false", "off", "mapped_high"},
    c \in {"default", "auto", "none", "required"}:
      CodexBody(r,c).toolChoice = IF c = "default" THEN "auto" ELSE c
ReasoningBodyStable == reasoningOriginal.body # "none" => reasoningFinal.body = reasoningOriginal.body
ReasoningCipherSticky == reasoningOriginal.body # "none" /\ reasoningOriginal.cipher \notin {"absent", "null", "empty"}
                        => reasoningFinal.cipher = reasoningOriginal.cipher
IncompleteStreamUnknown == failureKind = "stream_incomplete" => unknown /\ retired /\ flight = 0 /\ ~terminal
Spec == Init /\ [][Next]_vars
=============================================================================
