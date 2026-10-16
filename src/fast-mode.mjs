// Fast is a root-owned family preference, not a model alias or a reasoning level.
export function supportsFastMode(model) {
  return ["gpt-6-astra", "gpt-6.1-sol"].includes(model?.id)
    && ((model.provider === "openai-codex" && model.api === "openai-codex-responses")
      || (model.provider === "openai" && model.api === "openai-responses"));
}
export function fastModeOptions(model, enabled) {
  return enabled === true && supportsFastMode(model) ? { serviceTier: "priority" } : {};
}

// STOCK diagnoses WebSocket failures but not failed SSE body reads. Observe
// only that read boundary; parsing, hooks, EOF and cancellation are not proof.
function observeCodexSse(options) {
  let attempt;
  const fetch = options.fetch ?? globalThis.fetch;
  const observed = { ...options,
    async onProviderStreamEvent(...args) {
      const current = attempt;
      await options.onProviderStreamEvent?.(...args);
      if (current) current.started = true;
    },
    async fetch(...args) {
      const signal = args[1]?.signal !== undefined ? args[1].signal : args[0] instanceof Request ? args[0].signal : undefined;
      const current = attempt = { started: false, readFailed: false, canceled: false, signal };
      const response = await fetch(...args);
      if (!response.ok || !response.body || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream") return response;
      let reader, released = false;
      const release = () => { if (reader && !released) { released = true; reader.releaseLock(); } };
      const body = new ReadableStream({
        async pull(controller) {
          reader ??= response.body.getReader();
          let part;
          try { part = await reader.read(); }
          catch (error) {
            if (!current.canceled && !options.signal?.aborted && !current.signal?.aborted && error?.name !== "AbortError") current.readFailed = true;
            release(); if (!current.canceled) controller.error(error); return;
          }
          if (current.canceled) return;
          if (part.done) { release(); controller.close(); }
          else controller.enqueue(part.value);
        },
        async cancel(reason) {
          current.canceled = true;
          try { await (reader ? reader.cancel(reason) : response.body.cancel(reason)); } finally { release(); }
        },
      }, { highWaterMark: 0 });
      const metadata = result => {
        for (const key of ["url", "type", "redirected"]) Object.defineProperty(result, key, { value: response[key] });
        const clone = result.clone.bind(result);
        Object.defineProperty(result, "clone", { value: () => metadata(clone()) });
        return result;
      };
      return metadata(new Response(body, response));
    },
  };
  const annotate = message => {
    if (attempt?.readFailed && attempt.started && !attempt.canceled && !attempt.signal?.aborted
      && !options.signal?.aborted && message.stopReason === "error") {
      attempt.readFailed = false;
      (message.diagnostics ??= []).push({ type: "provider_transport_failure", timestamp: Date.now(), details: {
        producer: "persistent-harness-sse-body-read-v1", configuredTransport: options.transport ?? "auto",
        transport: "sse", eventsEmitted: true, phase: "after_message_stream_start",
      } });
    }
    return message;
  };
  return { options: observed, wrap(stream) {
    const result = stream.result().then(annotate);
    return { result: () => result, async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        if (event.type === "error") annotate(event.error);
        yield event;
      }
    } };
  } };
}

// Pi 0.99.1 streamSimple drops serviceTier. Keep the ordinary route unchanged;
// Fast uses the public detailed stream with the same public simple-option helpers.
export function streamSessionRequest(models, model, context, options, { api, simpleOptions }) {
  const observation = model.provider === "openai-codex" && model.api === "openai-codex-responses" ? observeCodexSse(options) : null;
  options = observation?.options ?? options;
  const wrap = stream => observation ? observation.wrap(stream) : stream;
  if (options.serviceTier !== "priority" || !supportsFastMode(model)) return wrap(models.streamSimple(model, context, options));
  const transcript = api.normalizeContext(context);
  const clamped = options.reasoning ? api.clampThinkingLevel(model, options.reasoning) : undefined;
  return wrap(models.stream(model, transcript, {
    ...simpleOptions.buildBaseOptions(model, transcript, options, options.apiKey),
    toolChoice: options.toolChoice,
    reasoningEffort: clamped === "off" ? undefined : clamped,
    serviceTier: "priority",
    // ModelRuntime applies this before the provider receives detailed options.
    transformHeaders: options.transformHeaders,
  }));
}
