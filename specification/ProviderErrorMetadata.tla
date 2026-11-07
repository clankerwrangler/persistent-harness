--------------------- MODULE ProviderErrorMetadata ---------------------
\* Sources:
\*   src/native-provider.mjs sha256:576469fb04ff3b98dc41e061270feb00596f0c437792ffa2aaede677ad3c1519
EXTENDS Naturals, FiniteSets, TLC
\* Only exact allowlisted code/type tokens may enter auxiliary diagnostics.
\* Private code/type/message/param values remain raw inputs, never output fields.
\* A safe reconnect rejection can be followed by success or a different error;
\* metadata belongs to the final attempt, not the previous rejected attempt.
CodeCategory == [c \in {"context_length_exceeded", "invalid_request_error",
  "invalid_value", "missing_required_parameter", "unsupported_parameter",
  "unknown_parameter", "invalid_api_key", "authentication_error",
  "permission_denied", "model_not_found", "rate_limit_exceeded",
  "insufficient_quota", "server_error", "internal_error", "service_unavailable",
  "previous_response_not_found", "websocket_connection_limit_reached",
  "invalid_prompt", "data_residency_mismatch", "bio_policy", "misalignment_policy_violation",
  "vector_store_timeout", "invalid_image", "invalid_image_format", "invalid_base64_image",
  "invalid_image_url", "image_too_large", "image_too_small", "image_parse_error",
  "image_content_policy_violation", "invalid_image_mode", "image_file_too_large",
  "unsupported_image_media_type", "empty_image_file", "failed_to_download_image", "image_file_not_found"} |->
  CASE c = "context_length_exceeded" -> "context"
    [] c \in {"invalid_request_error", "invalid_value", "missing_required_parameter",
         "unsupported_parameter", "unknown_parameter"} -> "request"
    [] c \in {"invalid_api_key", "authentication_error"} -> "authentication"
    [] c = "permission_denied" -> "permission"
    [] c = "model_not_found" -> "not_found"
    [] c = "rate_limit_exceeded" -> "rate_limit"
    [] c = "insufficient_quota" -> "quota"
    [] c \in {"server_error", "internal_error", "service_unavailable"} -> "server"
    [] c \in {"previous_response_not_found", "websocket_connection_limit_reached"} -> "transport"
    [] c = "data_residency_mismatch" -> "permission"
    [] c \in {"bio_policy", "misalignment_policy_violation", "image_content_policy_violation"} -> "content_policy"
    [] c = "vector_store_timeout" -> "server"
    [] OTHER -> "request"]
TypeCategory == [t \in {"invalid_request_error", "authentication_error",
  "permission_error", "not_found_error", "rate_limit_error", "server_error", "api_error"} |->
  CASE t = "invalid_request_error" -> "request"
    [] t = "authentication_error" -> "authentication"
    [] t = "permission_error" -> "permission"
    [] t = "not_found_error" -> "not_found"
    [] t = "rate_limit_error" -> "rate_limit"
    [] OTHER -> "server"]
Private == {"PRIVATE_A", "PRIVATE_B"}
NonTokens == {"missing", "null", "malformed"}
Shapes == {[error |-> "object", message |-> "string"],
  [error |-> "object", message |-> "missing"], [error |-> "string", message |-> "string"],
  [error |-> "missing", message |-> "string"], [error |-> "other", message |-> "other"], [error |-> "null", message |-> "null"], [error |-> "object", message |-> "object"]}
State(v, known) == IF v \in known THEN "known" ELSE IF v \in NonTokens THEN
  (IF v = "malformed" THEN "invalid" ELSE "absent") ELSE "unknown"
Safe(c, t, f, s) == [version |-> 2,
  code |-> IF c \in DOMAIN CodeCategory THEN c ELSE "unknown",
  category |-> IF c \in DOMAIN CodeCategory THEN CodeCategory[c]
    ELSE IF t \in DOMAIN TypeCategory THEN TypeCategory[t] ELSE "unknown",
  event |-> f, codeState |-> State(c, DOMAIN CodeCategory), typeState |-> State(t, DOMAIN TypeCategory),
  errorShape |-> s.error, messageShape |-> s.message]
Rejected == {"previous_response_not_found", "websocket_connection_limit_reached"}
VARIABLES raw, frame, sawRaw, nextOutcome, phase, pending, diagnostic, errorMessage, retried
metadataVars == <<raw, frame, sawRaw, nextOutcome, phase, pending, diagnostic, errorMessage, retried>>
VARIABLES closeAttempt, closePhase, closeOwners, closeDisposed, closeFaulted,
          closeBindings, closeRecords, closeFenced, closeFrozen
closeVars == <<closeAttempt, closePhase, closeOwners, closeDisposed, closeFaulted,
               closeBindings, closeRecords, closeFenced, closeFrozen>>
vars == <<metadataVars, closeVars>>
CloseInit == /\ closeAttempt = 0 /\ closePhase = "idle"
             /\ closeOwners = [s \in 1..2 |-> 0] /\ closeDisposed = {} /\ closeFaulted = {}
             /\ closeBindings = [a \in 1..2 |-> 0] /\ closeRecords = [a \in 1..2 |-> 0]
             /\ closeFenced = {} /\ closeFrozen = [a \in 1..2 |-> 0]
ShouldRetry == frame = "error" /\ raw.code \in Rejected /\ ~sawRaw
LegacyError == IF frame = "hook" THEN "provider_request_failed"
  ELSE IF raw.code = "context_length_exceeded" THEN "context_length_exceeded"
  ELSE IF ShouldRetry THEN raw.code
  ELSE IF frame = "error" THEN "provider_error" ELSE "provider_response_failed"
Init == /\ CloseInit
        /\ raw \in [code : (DOMAIN CodeCategory) \cup Private \cup NonTokens,
                    type : (DOMAIN TypeCategory) \cup Private \cup NonTokens,
                    message : {"PRIVATE_A", "PRIVATE_B"}, param : {"PRIVATE_A", "PRIVATE_B"}, shape : Shapes]
        /\ frame \in {"error", "response.failed", "hook"}
        /\ sawRaw \in BOOLEAN
        /\ nextOutcome \in {"success", "hook", "unknown_provider_error"}
        /\ phase = "input" /\ pending = [x \in {} |-> x] /\ diagnostic = [x \in {} |-> x]
        /\ errorMessage = "" /\ retried = FALSE
Observe == /\ phase = "input"
           /\ pending' = IF frame = "hook" THEN [x \in {} |-> x] ELSE Safe(raw.code, raw.type, frame, raw.shape)
           /\ errorMessage' = LegacyError /\ retried' = ShouldRetry
           /\ phase' = "observed"
           /\ UNCHANGED <<raw, frame, sawRaw, nextOutcome, diagnostic, closeVars>>
Finish == /\ phase = "observed"
          /\ pending' = IF retried THEN [x \in {} |-> x] ELSE pending
          /\ diagnostic' = IF ~retried THEN pending
               ELSE IF nextOutcome = "unknown_provider_error" THEN Safe("missing", "missing", "error", [error |-> "missing", message |-> "missing"]) ELSE [x \in {} |-> x]
          /\ errorMessage' = IF ~retried THEN errorMessage
               ELSE CASE nextOutcome = "success" -> ""
                  [] nextOutcome = "hook" -> "provider_request_failed"
                  [] OTHER -> "provider_error"
          /\ phase' = "finished"
          /\ UNCHANGED <<raw, frame, sawRaw, nextOutcome, retried, closeVars>>
Next == Observe \/ Finish \/ (phase = "finished" /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
FixedFields == \A d \in {pending, diagnostic} :
  d = [x \in {} |-> x] \/ (DOMAIN d = {"version", "code", "category", "event", "codeState", "typeState", "errorShape", "messageShape"} /\ d.version = 2
    /\ d.code \in (DOMAIN CodeCategory) \cup {"unknown"}
    /\ d.category \in {CodeCategory[c] : c \in DOMAIN CodeCategory} \cup {"unknown"}
    /\ d.event \in {"error", "response.failed"}
    /\ d.codeState \in {"known", "unknown", "absent", "invalid"}
    /\ d.typeState \in {"known", "unknown", "absent", "invalid"}
    /\ d.errorShape \in {"object", "string", "missing", "null", "other"}
    /\ d.messageShape \in {"string", "object", "missing", "null", "other"})
NoRawPayload == \A d \in {pending, diagnostic} :
  d = [x \in {} |-> x] \/ (d.code \notin Private /\ d.category \notin Private)
UnknownNoninterference == \A a, b \in Private, t \in (DOMAIN TypeCategory) \cup Private, s \in Shapes :
  Safe(a, t, "error", s) = Safe(b, t, "error", s)
LegacyBehavior == phase # "input" => retried = ShouldRetry
LegacyMessage == phase = "observed" \/ (phase = "finished" /\ ~retried) => errorMessage = LegacyError
NoStaleMetadata == phase = "finished" /\ retried =>
  pending = [x \in {} |-> x] /\ (nextOutcome = "unknown_provider_error" \/ diagnostic = [x \in {} |-> x])
NoHookMetadata == phase = "finished" /\ frame = "hook" => diagnostic = [x \in {} |-> x]

\* Close callbacks observe only the inbox's bound, unfenced attempt. Binding
\* begins before open (so pre-send closes count) and ends at retirement.
\* A disposed inbox can still deliver a previously captured callback.
CloseBegin(s) == /\ closePhase = "idle" /\ closeAttempt < 2
 /\ s \notin closeDisposed \cup closeFaulted /\ closeOwners[s] = 0
 /\ closeAttempt' = closeAttempt + 1 /\ closePhase' = "opening"
 /\ closeOwners' = [closeOwners EXCEPT ![s] = closeAttempt + 1]
 /\ closeBindings' = [closeBindings EXCEPT ![closeAttempt + 1] = s]
 /\ UNCHANGED <<closeDisposed, closeFaulted, closeRecords, closeFenced, closeFrozen>>
CloseSend == /\ closePhase = "opening" /\ closePhase' = "wire"
 /\ UNCHANGED <<closeAttempt, closeOwners, closeDisposed, closeFaulted,
                closeBindings, closeRecords, closeFenced, closeFrozen>>
CloseTarget(s) == IF s \notin closeDisposed /\ closeOwners[s] # 0 /\ closeOwners[s] \notin closeFenced
                  THEN closeOwners[s] ELSE 0
UnsafeCloseTarget(s) == closeAttempt
CloseEvent(s) ==
 /\ LET target == CloseTarget(s)
    IN closeRecords' = IF target = 0 THEN closeRecords ELSE [closeRecords EXCEPT ![target] = s]
 /\ closeFaulted' = IF s \in closeDisposed THEN closeFaulted ELSE closeFaulted \cup {s}
 /\ UNCHANGED <<closeAttempt, closePhase, closeOwners, closeDisposed,
                closeBindings, closeFenced, closeFrozen>>
CloseRetire == /\ closePhase \in {"opening", "wire"} /\ closePhase' = "idle"
 /\ closeOwners' = [s \in 1..2 |-> IF closeOwners[s] = closeAttempt THEN 0 ELSE closeOwners[s]]
 /\ closeFenced' = closeFenced \cup {closeAttempt}
 /\ closeFrozen' = [closeFrozen EXCEPT ![closeAttempt] = closeRecords[closeAttempt]]
 /\ UNCHANGED <<closeAttempt, closeDisposed, closeFaulted, closeBindings, closeRecords>>
CloseDispose(s) == /\ closeDisposed' = closeDisposed \cup {s}
 /\ UNCHANGED <<closeAttempt, closePhase, closeOwners, closeFaulted,
                closeBindings, closeRecords, closeFenced, closeFrozen>>
CloseScenarioInit == /\ CloseInit
 /\ raw = "unused" /\ frame = "unused" /\ sawRaw = FALSE /\ nextOutcome = "unused"
 /\ phase = "unused" /\ pending = "unused" /\ diagnostic = "unused" /\ errorMessage = "" /\ retried = FALSE
CloseNext == /\ ((\E s \in 1..2: CloseBegin(s) \/ CloseEvent(s) \/ CloseDispose(s)) \/ CloseSend \/ CloseRetire)
             /\ UNCHANGED metadataVars
CloseSpec == CloseScenarioInit /\ [][CloseNext]_vars
CloseAttemptOwned == \A a \in 1..2: closeRecords[a] = 0 \/ closeRecords[a] = closeBindings[a]
CloseRetiredImmutable == \A a \in closeFenced: closeRecords[a] = closeFrozen[a]
CloseIdleUnbound == closePhase = "idle" => \A s \in 1..2: closeOwners[s] = 0

=============================================================================
