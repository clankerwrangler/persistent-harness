import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";

const responses = new Set(["openai-responses", "openai-codex-responses"]);
const terminalTypes = new Set(["response.completed", "response.done", "response.incomplete", "response.failed"]);
const rejectedCodes = new Set(["previous_response_not_found", "websocket_connection_limit_reached"]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const nonempty = (value) => typeof value === "string" && value.length > 0;
class AdapterError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new AdapterError(code); }
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function parse(text) { try { return JSON.parse(text); } catch { fail("invalid_provider_json"); } }
// A complete raw reasoning item is immutable except for a missing ciphertext
// being filled at terminal. Compare the entire item before the public parser can
// silently retain stale encryption or discard other changed reasoning fields.
function validateCompleteReasoning(item, prior) {
  if (item?.type !== "reasoning") return;
  const cipher = item.encrypted_content;
  if (cipher !== undefined && cipher !== null && typeof cipher !== "string") fail("invalid_reasoning_encryption");
  if (!prior || prior.type !== "reasoning" || equal(prior, item)) return;
  if ((prior.encrypted_content == null || prior.encrypted_content === "") && nonempty(cipher) &&
      equal({ ...prior, encrypted_content: cipher }, item)) return;
  fail("conflicting_terminal_reasoning");
}
function mergeHeaders(...groups) {
  const result = {};
  for (const group of groups) for (const [key, value] of Object.entries(group ?? {})) result[key.toLowerCase()] = value;
  return result;
}
function wireHeaders(headers) { return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== null)); }
function wait(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("request_aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("request_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function message(model) {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
    stopReason: "pending", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function inputContent(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return (content ?? []).map((block) => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    if (block.type === "image") return { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}`, detail: "auto" };
    fail("unsupported_input_block");
  });
}
function callIds(call) {
  if (nonempty(call.providerCallId) && nonempty(call.providerItemId)) return [call.providerCallId, call.providerItemId];
  const parts = call.id.split("|");
  if (parts.length > 2) fail("ambiguous_replay_call_id");
  return parts;
}
// Deliberately not transformMessages(): it manufactures missing tool outputs.
function replay(model, messages, grammar) {
  const input = [], identities = new Map();
  for (const msg of messages) for (const block of msg.role === "assistant" ? msg.content : []) {
    if (block.type !== "toolCall") continue;
    const ids = callIds(block);
    if (identities.has(block.id) && !equal(identities.get(block.id), ids)) fail("ambiguous_replay_call_id");
    identities.set(block.id, ids);
  }
  for (const msg of messages) {
    if (msg.role === "user") input.push({ role: "user", content: inputContent(msg.content) });
    else if (msg.role === "toolResult") {
      const [callId] = identities.get(msg.toolCallId) ?? callIds({ ...msg, id: msg.toolCallId });
      const content = inputContent(msg.content);
      input.push({ type: grammar.has(msg.toolName) ? "custom_tool_call_output" : "function_call_output", call_id: callId,
        output: content.some((block) => block.type === "input_image") ? content : content.map((block) => block.text).join("\n") });
    } else if (msg.role === "assistant") {
      const same = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (same && block.thinkingSignature) {
            const item = parse(block.thinkingSignature);
            if (item.type !== "reasoning") fail("invalid_reasoning_replay");
            input.push(item);
          } else if (block.thinking && !block.redacted) {
            input.push({ role: "assistant", content: [{ type: "output_text", text: block.thinking, annotations: [] }] });
          }
        } else if (block.type === "text") {
          const signature = same && block.textSignature;
          const meta = signature ? (signature.startsWith("{") ? parse(signature) : { id: signature }) : {};
          input.push({ type: "message", role: "assistant", ...(meta.id ? { id: meta.id } : {}),
            ...(meta.phase ? { phase: meta.phase } : {}), status: "completed",
            content: [{ type: "output_text", text: block.text, annotations: [] }] });
        } else if (block.type === "toolCall") {
          const [callId, itemId] = callIds(block);
          const property = grammar.get(block.name);
          input.push({ type: property ? "custom_tool_call" : "function_call", call_id: callId,
            ...(itemId ? { id: itemId } : {}), name: block.name,
            ...(property ? { input: block.arguments[property] } : { arguments: JSON.stringify(block.arguments) }),
            ...(block.namespace !== undefined ? { namespace: block.namespace } : {}),
            ...(block.async === true ? { async: true } : {}) });
        } else fail("unsupported_assistant_block");
      }
    } else fail("unsupported_message_role");
  }
  return input;
}
function buildBody(api, responsesApi, model, context, options) {
  const codex = model.api === "openai-codex-responses";
  const tools = responsesApi.convertResponsesTools(context.tools ?? [], {
    supportsStrictMode: model.compat?.supportsStrictMode ?? codex,
    supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
    strict: codex ? null : false,
  });
  const grammar = new Map();
  tools.forEach((tool, index) => {
    const source = context.tools[index];
    if (tool.type === "custom") grammar.set(tool.name, Object.keys(source.parameters.properties)[0]);
    if (source.async === true && model.compat?.supportsAsyncTools === true) tool.async = true;
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) fail("duplicate_tool_name");
  const input = replay(model, context.messages, grammar);
  if (!codex && context.systemPrompt) input.unshift({ role: model.reasoning && model.compat?.supportsDeveloperRole !== false ? "developer" : "system", content: context.systemPrompt });
  const body = { model: model.id, stream: true, store: false, input, tools,
    ...(codex ? { instructions: context.systemPrompt || "You are a helpful assistant.", text: { verbosity: options.textVerbosity ?? "low" }, parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"], tool_choice: options.toolChoice ?? "auto" } : {}) };
  if (options.cacheRetention !== "none" && options.sessionId) body.prompt_cache_key = options.sessionId;
  if (options.maxTokens !== undefined) body.max_output_tokens = Math.max(16, options.maxTokens);
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
  if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
  if (model.reasoning) {
    const level = options.reasoningEffort ?? (options.reasoning ? api.clampThinkingLevel(model, options.reasoning) : "off");
    const effort = model.thinkingLevelMap?.[level] ?? (level === "off" ? "none" : level);
    if (model.thinkingLevelMap?.[level] !== null) body.reasoning = { effort, ...(effort !== "none" ? { summary: options.reasoningSummary ?? "auto" } : {}) };
    body.include = ["reasoning.encrypted_content"];
  }
  return { body: Object.assign(body, model.samplingParams, options.samplingParams), grammar, definitions: clone(tools) };
}
function endpoint(model) {
  const base = model.baseUrl.replace(/\/+$/, "");
  if (model.api === "openai-codex-responses") return base.endsWith("/codex/responses") ? base : `${base}${base.endsWith("/codex") ? "" : "/codex"}/responses`;
  return base.endsWith("/responses") ? base : `${base}/responses`;
}
async function* sse(response, signal, maxFrameBytes) {
  if (!response.body) fail("missing_response_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { value, done } = await wait(reader.read(), signal);
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) buffer += "\n\n";
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // Keep a trailing CR until the next chunk to recognize CRLF correctly.
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === "") {
          const text = data.join("\n"); data = [];
          if (text && text !== "[DONE]") yield parse(text);
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        if (Buffer.byteLength(buffer) + data.reduce((size, part) => size + Buffer.byteLength(part), 0) > maxFrameBytes) fail("provider_frame_limit");
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) fail("provider_frame_limit");
      if (done) break;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
// One persistent inbox attaches before open/send. This prevents missing an immediate reply.
function socketInbox(WebSocket, url, headers, signal, limits) {
  const socket = new WebSocket(url, { headers });
  let queue = [], wake, fault, queuedBytes = 0, disposed = false;
  let opened, openFailed;
  const open = new Promise((resolve, reject) => { opened = resolve; openFailed = reject; });
  // An early failure can occur before the caller awaits open.
  open.catch(() => {});
  const notify = () => { wake?.(); wake = undefined; };
  const bad = (code) => { if (disposed) return; fault = code; openFailed(new AdapterError(code)); notify(); };
  const listeners = {
    open: () => opened(), error: () => bad("websocket_transport_error"), close: () => bad("websocket_closed"),
    message: ({ data }) => {
      if (disposed) return;
      const text = typeof data === "string" ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : null;
      if (text === null) return bad("unsupported_websocket_frame");
      const bytes = Buffer.byteLength(text); queuedBytes += bytes;
      if (bytes > limits.maxFrameBytes || queuedBytes > limits.maxQueuedBytes) return bad("provider_frame_limit");
      queue.push({ text, bytes }); notify();
    },
  };
  for (const [name, listener] of Object.entries(listeners)) socket.addEventListener(name, listener);
  const timeout = setTimeout(() => { bad("websocket_connect_timeout"); socket.close(); }, limits.connectTimeoutMs);
  const abort = () => { bad("request_aborted"); socket.close(); };
  signal.addEventListener("abort", abort, { once: true });
  return {
    socket, open: wait(open, signal).finally(() => { clearTimeout(timeout); signal.removeEventListener("abort", abort); }),
    healthy: () => !fault && socket.readyState === 1 && queue.length === 0,
    async next(signal) {
      while (!queue.length) {
        if (fault) fail(fault);
        await wait(new Promise((resolve) => { wake = resolve; }), signal);
      }
      const frame = queue.shift(); queuedBytes -= frame.bytes;
      return parse(frame.text);
    },
    close() {
      disposed = true;
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      for (const [name, listener] of Object.entries(listeners)) socket.removeEventListener(name, listener);
      // ws emits an error if closed during its handshake. This listener cannot admit data.
      const ignoreError = () => {};
      socket.addEventListener("error", ignoreError);
      socket.addEventListener("close", () => socket.removeEventListener("error", ignoreError), { once: true });
      socket.close(); queue = []; queuedBytes = 0; fault = "websocket_closed"; notify();
    },
  };
}

/**
 * api: stock pi-ai root exports; responsesApi: public api/openai-responses-shared exports.
 * WebSocket injection must implement new (url, {headers}), EventTarget events, readyState,
 * send(string), and close(). It must actually send the supplied headers (for example ws).
 * One adapter owns one inference flight and one session connection. No credentials persist.
 */
export function createNativeProviderAdapter({ api, responsesApi, modelRuntime, transportOptions = {} }) {
  if (!api?.createAssistantMessageEventStream || !responsesApi?.processResponsesStream || !modelRuntime?.getAuth) fail("missing_public_provider_services");
  const proofs = new WeakMap();
  let active, closed = false, connection;
  const disconnect = () => { clearTimeout(connection?.idleTimer); connection?.inbox.close(); connection = undefined; };
  const limits = { maxFrameBytes: 16 * 1024 * 1024, maxQueuedBytes: 32 * 1024 * 1024, connectTimeoutMs: 15000, cacheTtlMs: 300000, maxSocketAgeMs: 3300000, ...transportOptions };
  function stream(model, context, options = {}) {
    const events = api.createAssistantMessageEventStream();
    const output = message(model);
    const controller = new AbortController();
    if (active || closed) {
      output.stopReason = "error"; output.errorMessage = closed ? "provider_adapter_closed" : "provider_flight_active";
      events.push({ type: "error", reason: "error", error: output }); events.end(); return events;
    }
    active = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let timer, timedOut = false;
    if (options.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs);
    const signal = controller.signal;
    const requestId = randomUUID(), attempts = [];
    let attempt, providerTools = false;
    const beginAttempt = (transport) => {
      attempt = { attemptId: randomUUID(), attemptNumber: attempts.length + 1, transport,
        sent: false, created: false, observedCalls: [], providerTools, retired: false, fenced: false,
        possibleUsage: false, outcome: "not_sent" };
      attempts.push(attempt);
    };
    const retire = () => {
      if (attempt) { attempt.retired = true; attempt.fenced = true; }
    };
    (async () => {
      let final;
      try {
        if (signal.aborted) fail("request_aborted");
        if (!responses.has(model.api)) {
          if (model.compat?.supportsAsyncTools === true && context.tools?.some((tool) => tool.async === true)) fail("native_transport_not_supported");
          const inner = modelRuntime.streamSimple(model, context, { ...options, signal });
          for await (const event of inner) {
            if (event.type === "done" || event.type === "error") final = event;
            else events.push(event);
          }
          if (!final) fail("missing_terminal_event");
          return;
        }
        const auth = (await wait(modelRuntime.getAuth(model, { apiKey: options.apiKey, env: options.env, signal }), signal))?.auth ?? {};
        const effectiveModel = { ...model, baseUrl: auth.baseUrl ?? model.baseUrl };
        const key = options.apiKey ?? auth.apiKey;
        const codex = model.api === "openai-codex-responses";
        let defaults = { "content-type": "application/json", accept: "text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) };
        if (codex) {
          if (key) {
            const token = parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
            const account = token["https://api.openai.com/auth"]?.chatgpt_account_id;
            if (!nonempty(account)) fail("missing_codex_account_id");
            defaults["chatgpt-account-id"] = account;
          }
          defaults.originator = "pi";
        }
        if (options.sessionId) defaults[codex ? "session-id" : "session_id"] = options.sessionId;
        let headers = mergeHeaders(defaults, auth.headers, model.headers, options.headers);
        if (options.transformHeaders) headers = mergeHeaders(await wait(options.transformHeaders(headers), signal));
        headers = wireHeaders(headers);
        const { body, grammar, definitions } = buildBody(api, responsesApi, effectiveModel, context, options);
        const changed = options.onPayload ? await wait(options.onPayload(body, effectiveModel), signal) : undefined;
        const full = clone(changed === undefined ? body : changed);
        if (full.stream !== true || !Array.isArray(full.input)) fail("invalid_stream_payload");
        if (full.previous_response_id !== undefined) fail("use_previousResponseId_option_with_full_context");
        const opted = new Map();
        if (model.compat?.supportsAsyncTools === true && full.model === model.id) {
          for (const tool of context.tools ?? []) {
            const advertised = (full.tools ?? []).filter((candidate) => candidate.name === tool.name);
            const expected = definitions.find((definition) => definition.name === tool.name);
            if (tool.async === true && advertised.length === 1 && advertised[0].async === true &&
                advertised[0].type === expected.type && equal(advertised[0].parameters, expected.parameters) && equal(advertised[0].format, expected.format)) opted.set(tool.name, expected.type);
          }
        }
        providerTools = (full.tools ?? []).some((tool) => !["function", "custom"].includes(tool.type));
        const url = endpoint(effectiveModel);
        const mode = options.transport ?? "auto";
        if (!["auto", "sse", "websocket", "websocket-cached"].includes(mode)) fail("unsupported_transport");
        let rawResponseId, currentRaw, currentItem, rawEvidence, sawRaw = false;
        const slots = new Map(), completed = new Map(), itemIds = new Map(), callIds = new Map(), emittedIds = new Set();
        const callable = (item) => ["function_call", "custom_tool_call"].includes(item.type);
        const recordItem = (item, index, complete) => {
          if (!item || !Number.isInteger(index) || index < 0) fail("invalid_output_item");
          // A done envelope cannot override an explicitly incomplete call. Validate
          // before the public parser can emit an executable ordinary or native call.
          if (complete && callable(item) && item.status !== undefined && item.status !== "completed") fail("incomplete_output_item");
          if (complete) validateCompleteReasoning(item);
          for (const [id, ids] of [[item.id, itemIds], [item.call_id, callIds]]) {
            if (!nonempty(id)) continue;
            if (ids.has(id) && ids.get(id) !== index) fail("duplicate_provider_identity");
            ids.set(id, index);
          }
          const previous = slots.get(index), identity = [item.type, item.id, item.call_id, item.name];
          if (previous && !equal(previous, identity)) fail("output_identity_changed");
          if (completed.has(index)) fail("duplicate_complete_item");
          slots.set(index, identity);
          if (complete) completed.set(index, item);
          if (callable(item)) {
            let seen = attempt.observedCalls.find((call) => call.itemId === item.id);
            if (!seen) { seen = { itemId: item.id, callId: item.call_id, complete: false, native: false }; attempt.observedCalls.push(seen); }
            seen.complete = complete;
          }
        };
        const observed = async function* (wire, retired) {
          for await (const raw of wire) {
            if (signal.aborted) fail("request_aborted");
            // Successful generations share an inbox, not admission authority. Fence
            // their identities before start, parser state, usage, or proof changes.
            if (retired) {
              const responseIds = [raw.response?.id, raw.response_id].filter(nonempty);
              if (responseIds.some((id) => retired.responses.has(id))) continue;
              const oldItem = (item) => retired.items.has(item?.id) || retired.calls.has(item?.call_id);
              if (oldItem(raw.item) || retired.items.has(raw.item_id)) {
                if (responseIds.length) fail("retired_output_identity");
                continue;
              }
              if (raw.response?.output?.some(oldItem)) {
                if (responseIds.length) fail("retired_output_identity");
                continue;
              }
            }
            if (raw.type === "error") {
              const code = raw.code ?? raw.error?.code;
              if (!sawRaw && rejectedCodes.has(code)) {
                attempt.outcome = "rejected"; attempt.possibleUsage = false; fail(code);
              }
              attempt.outcome = "failed";
              fail(code === "context_length_exceeded" ? code : "provider_error");
            }
            if (!sawRaw && attempt.transport === "websocket") events.push({ type: "start", partial: output });
            sawRaw = true;
            if (raw.type === "response.created") attempt.created = true;
            const responseId = raw.response?.id ?? raw.response_id;
            if (responseId) {
              if (rawResponseId && rawResponseId !== responseId) fail("response_identity_changed");
              rawResponseId = responseId; attempt.responseId = responseId;
            }
            currentRaw = raw; currentItem = raw.item; rawEvidence = undefined;
            if (raw.response && typeof raw.response.end_turn === "boolean") output.endTurn = raw.response.end_turn;
            if (raw.type === "response.output_item.added" || raw.type === "response.output_item.done") recordItem(raw.item, raw.output_index, raw.type.endsWith(".done"));
            if (terminalTypes.has(raw.type)) {
              if (!["completed", "incomplete", "failed"].includes(raw.response?.status)) fail("invalid_terminal_status");
              attempt.outcome = raw.type === "response.failed" ? "failed" : "completed";
              attempt.possibleUsage = !raw.response?.usage;
              output.rawStopReason = raw.response?.status;
              if (raw.response?.usage) {
                const usage = raw.response.usage, details = usage.input_tokens_details;
                output.usage.input = Math.max(0, (usage.input_tokens ?? 0) - (details?.cached_tokens ?? 0) - (details?.cache_write_tokens ?? 0));
                output.usage.output = usage.output_tokens ?? 0;
                output.usage.cacheRead = details?.cached_tokens ?? 0; output.usage.cacheWrite = details?.cache_write_tokens ?? 0;
                output.usage.reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
                output.usage.totalTokens = usage.total_tokens ?? 0;
                api.calculateCost(model, output.usage);
              }
              if (raw.type === "response.failed") fail(raw.response?.error?.code === "context_length_exceeded" ? "context_length_exceeded" : "provider_response_failed");
              // Preflight every reasoning item before normalizing ANY terminal
              // item: a corrupt repeated signature cannot authorize a new call.
              for (const item of raw.response.output ?? []) {
                if (item?.type === "reasoning") validateCompleteReasoning(item, completed.get(itemIds.get(item.id)));
              }
              const listed = new Set();
              for (const item of raw.response.output ?? []) {
                if (!["function_call", "custom_tool_call", "reasoning", "message"].includes(item.type)) continue;
                if (!nonempty(item.id) || listed.has(item.id)) fail("duplicate_terminal_item");
                listed.add(item.id);
                const index = itemIds.get(item.id) ?? (slots.size ? Math.max(...slots.keys()) + 1 : 0);
                const prior = completed.get(index);
                if (prior) {
                  if (!equal([prior.type, prior.id, prior.call_id, prior.name], [item.type, item.id, item.call_id, item.name]) ||
                      (callable(item) && (!equal(prior.arguments, item.arguments) || !equal(prior.input, item.input) ||
                        (item.async !== undefined && item.async !== prior.async) || (item.status !== undefined && item.status !== "completed")))) fail("conflicting_terminal_item");
                  continue;
                }
                if ((item.status !== undefined && item.status !== "completed") ||
                    (raw.response.status !== "completed" && item.status !== "completed")) fail("incomplete_terminal_item");
                recordItem(item, index, true);
                currentItem = item;
                // Only the parser envelope is normalized. Evidence remains the actual raw
                // terminal event and its complete item; no tool output/result is created.
                yield { type: "response.output_item.done", output_index: index, item };
              }
              for (const [index, identity] of slots) {
                if (["function_call", "custom_tool_call"].includes(identity[0]) && !completed.has(index)) fail("incomplete_tool_item_at_terminal");
              }
            }
            currentItem = raw.item;
            yield raw.type === "response.done" ? { ...raw, type: "response.completed" } : raw;
            currentRaw = undefined; currentItem = undefined; rawEvidence = undefined;
            if (terminalTypes.has(raw.type)) return;
          }
          // This is an actual clean wire EOF without an accepted terminal frame,
          // not classification of a parser/hook/transport exception by its text.
          if (signal.aborted) fail("request_aborted");
          fail("provider_stream_incomplete");
        };
        const sink = { push(event) {
          if (event.type === "toolcall_end") {
            const raw = currentRaw, item = currentItem, call = event.toolCall;
            if (!(raw?.type === "response.output_item.done" || terminalTypes.has(raw?.type)) || !["function_call", "custom_tool_call"].includes(item?.type)) fail("missing_raw_complete_item");
            if (!nonempty(item.id) || !nonempty(item.call_id) || !nonempty(item.name)) fail("missing_call_identity");
            if (call.id !== `${item.call_id}|${item.id}` || call.name !== item.name) fail("call_identity_changed");
            const args = item.type === "function_call" ? parse(item.arguments) : { [grammar.get(item.name) ?? "input"]: item.input };
            if (!args || typeof args !== "object" || Array.isArray(args) || !equal(call.arguments, args)) fail("invalid_complete_arguments");
            if (emittedIds.has(call.id)) fail("ambiguous_complete_call_id");
            emittedIds.add(call.id);
            call.providerCallId = item.call_id; call.providerItemId = item.id;
            if (nonempty(rawResponseId) && nonempty(item.id) && nonempty(item.call_id) && item.async === true && opted.get(item.name) === (item.type === "function_call" ? "function" : "custom") && (item.status === undefined || item.status === "completed")) {
              call.async = true;
              attempt.observedCalls.find((seen) => seen.itemId === item.id).native = true;
              const receipt = freeze({ responseId: rawResponseId, itemId: item.id, callId: item.call_id, call: clone(call), complete: true, native: true });
              rawEvidence ??= freeze(clone(raw));
              proofs.set(event, { receipt, raw: rawEvidence, advertisedModel: full.model });
            }
          }
          events.push(event);
        } };
        const consume = async (wire, retired) => {
          await responsesApi.processResponsesStream(observed(wire, retired), output, sink, model, {
            grammarToolInputProperties: grammar, serviceTier: options.serviceTier,
            applyServiceTierPricing(usage, tier) {
              const effectiveTier = codex && tier === "default" ? options.serviceTier : tier;
              const multiplier = effectiveTier === "flex" ? 0.5 : effectiveTier === "priority" ? (model.id === "gpt-5.5" ? 2.5 : 2) : 1;
              for (const field of Object.keys(usage.cost)) usage.cost[field] *= multiplier;
            },
          });
        };
        const sseRequest = async () => {
          disconnect(); retire(); beginAttempt("sse");
          attempt.sent = true; attempt.possibleUsage = true; attempt.outcome = "unknown";
          const response = await wait((options.fetch ?? transportOptions.fetch ?? globalThis.fetch)(url, {
            method: "POST", headers, body: JSON.stringify(full), signal,
          }), signal);
          await wait(options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model), signal);
          if (!response.ok) {
            attempt.outcome = "failed";
            await response.body?.cancel(); fail(`provider_http_${response.status}`);
          }
          events.push({ type: "start", partial: output });
          try { await consume(sse(response, signal, limits.maxFrameBytes)); } finally { retire(); }
        };
        if (mode === "sse") await sseRequest();
        else {
          const identity = createHash("sha256").update(JSON.stringify([url, model.provider, model.id, options.sessionId, headers])).digest("hex");
          
          for (let retry = 0; retry < 2; retry++) {
            beginAttempt("websocket");
            if (!connection?.inbox.healthy() || connection.identity !== identity || Date.now() - connection.createdAt >= limits.maxSocketAgeMs || !options.sessionId || options.cacheRetention === "none") disconnect();
            clearTimeout(connection?.idleTimer);
            try {
              if (!connection) {
                if (!transportOptions.WebSocket) fail("header_capable_websocket_required");
                const wsUrl = new URL(url); wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
                const inbox = socketInbox(transportOptions.WebSocket, wsUrl.toString(), headers, signal,
                  { ...limits, connectTimeoutMs: options.websocketConnectTimeoutMs ?? limits.connectTimeoutMs });
                connection = { inbox, identity, createdAt: Date.now(), retired: { responses: new Set(), items: new Set(), calls: new Set() } };
                await inbox.open;
              }
            } catch (error) {
              disconnect(); retire();
              if (mode !== "auto" || signal.aborted) throw error;
              await sseRequest(); break;
            }
            const entry = connection;
            let request = full;
            const chain = entry.chain;
            const template = ({ input, ...rest }) => rest;
            if (chain && mode !== "websocket" && (!options.previousResponseId || options.previousResponseId === chain.id) &&
                equal(template(full), chain.template) && equal(full.input.slice(0, chain.baseline.length), chain.baseline)) {
              request = { ...full, input: full.input.slice(chain.baseline.length), previous_response_id: chain.id };
            }
            async function* wire() {
              attempt.sent = true; attempt.possibleUsage = true; attempt.outcome = "unknown";
              entry.inbox.socket.send(JSON.stringify({ ...request, type: "response.create" }));
              // Only observed() may terminate a response: an old terminal frame can
              // be delayed until this request without ending its new generation.
              while (true) yield await entry.inbox.next(signal);
            }
            try {
              await consume(wire(), entry.retired);
              if (nonempty(rawResponseId)) entry.retired.responses.add(rawResponseId);
              for (const id of itemIds.keys()) entry.retired.items.add(id);
              for (const id of callIds.keys()) entry.retired.calls.add(id);
              entry.chain = { id: output.responseId, template: clone(template(full)), baseline: [...full.input, ...replay(model, [output], grammar)] };
              if (!options.sessionId || options.cacheRetention === "none" || !nonempty(rawResponseId)) disconnect();
              else {
                entry.idleTimer = setTimeout(() => { if (connection === entry) disconnect(); }, limits.cacheTtlMs);
                entry.idleTimer.unref?.();
              }
              // The completed parser generation is retired; the idle inbox cannot emit events.
              retire();
              break;
            } catch (error) {
              disconnect(); retire();
              if (retry === 0 && !sawRaw && rejectedCodes.has(error.code) && !signal.aborted) continue;
              throw error;
            }
          }
        }
        if (signal.aborted) fail("request_aborted");
        if (!["stop", "length", "toolUse"].includes(output.stopReason)) fail("provider_response_not_successful");
        final = { type: "done", reason: output.stopReason, message: output };
      } catch (error) {
        disconnect(); retire();
        output.stopReason = signal.aborted && !timedOut ? "aborted" : "error";
        // Never return raw transport exceptions (which can contain headers or request bodies).
        output.errorMessage = timedOut ? "provider_timeout" : signal.aborted ? "request_aborted" : (error instanceof AdapterError ? error.code : "provider_request_failed");
        for (const block of output.content) { delete block.partialJson; delete block.customInput; }
        final = { type: "error", reason: output.stopReason, error: output };
      } finally {
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        active = undefined;
        if (attempt) {
          output.nativeTransport = freeze({ version: 1, requestId, ...clone(attempt), attempts: clone(attempts) });
        }
        events.push(final); events.end();
      }
    })();
    return events;
  }
  return { stream, nativeCompletion: (event) => proofs.get(event)?.receipt ?? null,
    close() { closed = true; active?.abort(); disconnect(); } };
}
