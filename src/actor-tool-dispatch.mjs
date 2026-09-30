/** Public Pi tool dispatch for tool-owned calls; never writes session messages. */
export const NESTED_LIMITS = Object.freeze({ calls: 256, argumentBytes: 8192, totalArgumentBytes: 32768, errorChars: 500 });

export function addToolUsage(first, second) {
  if (!first) return structuredClone(second);
  if (!second) return structuredClone(first);
  const sum = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cacheWrite1h", "reasoning"]) {
    if (key in first || key in second) sum[key] = (first[key] ?? 0) + (second[key] ?? 0);
  }
  sum.cost = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "total"].map(key => [key, (first.cost?.[key] ?? 0) + (second.cost?.[key] ?? 0)]));
  return sum;
}

export class ActorToolDispatch {
  constructor({ runner, sdk, core, activeTools, emit }) {
    Object.assign(this, { runner, sdk, core, activeTools, emit });
    this.scopes = new Map();
    this.tail = Promise.resolve();
  }

  callableTools() {
    const active = this.activeTools();
    return this.sdk.wrapRegisteredTools(this.runner.getAllRegisteredTools().filter(({ definition }) => {
      const exposure = definition.exposure ?? "direct";
      return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(definition.name));
    }), this.runner);
  }

  open(id, signal, assistantMessage, messages) {
    if (this.scopes.has(id)) throw new Error("duplicate tool scope");
    const root = { calls: [], complete: true, argumentBytes: 0, pending: new Set(), usage: undefined, assistantMessage, messages };
    this.scopes.set(id, { root, signal, nextId: 1, accepting: true, holdsQueue: false });
  }

  async finish(id) {
    const scope = this.scopes.get(id);
    if (!scope) return {};
    // A tool cannot leave unaccounted fire-and-forget calls behind its canonical result.
    scope.accepting = false;
    while (scope.root.pending.size) await Promise.allSettled([...scope.root.pending]);
    this.scopes.delete(id);
    const { calls, complete, usage } = scope.root;
    return { ...(calls.length || !complete ? { nestedCalls: { calls, complete } } : {}), ...(usage ? { usage } : {}) };
  }

  execute(callerId, name, args, options = {}) {
    const scope = this.scopes.get(callerId);
    if (!scope?.accepting) return Promise.resolve({ toolCall: { type: "toolCall", id: `${callerId}/closed`, name, arguments: {} },
      result: { content: [{ type: "text", text: "The calling tool scope is closed; this call did not run." }], details: {} }, isError: true });
    const toolCall = { type: "toolCall", id: `${callerId}/${scope.nextId++}`, name, arguments: args ?? {} };
    const operation = this.runNested(scope, callerId, toolCall, options);
    scope.root.pending.add(operation);
    operation.finally(() => scope.root.pending.delete(operation)).catch(() => {});
    return operation;
  }

  async runNested(scope, parentToolCallId, toolCall, options) {
    const root = scope.root, started = performance.now();
    let record;
    if (root.calls.length < NESTED_LIMITS.calls) {
      record = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
      const json = JSON.stringify(toolCall.arguments), bytes = Buffer.byteLength(json);
      if (bytes <= NESTED_LIMITS.argumentBytes && root.argumentBytes + bytes <= NESTED_LIMITS.totalArgumentBytes) {
        record.arguments = JSON.parse(json); root.argumentBytes += bytes;
      } else { record.argumentsBytes = bytes; root.complete = false; }
      root.calls.push(record);
    } else root.complete = false;
    const event = { toolCallId: toolCall.id, toolName: toolCall.name, parentToolCallId };
    const signal = AbortSignal.any([scope.signal, options.signal].filter(Boolean));
    let release;
    if (!scope.holdsQueue) {
      const previous = this.tail;
      this.tail = new Promise(resolve => { release = resolve; });
      await previous;
    }
    this.scopes.set(toolCall.id, { root, signal, nextId: 1, accepting: true, holdsQueue: true });
    try {
      await this.emit({ type: "tool_execution_start", ...event, args: toolCall.arguments });
      const outcome = await this.core.runToolCall(toolCall, {
        tools: this.callableTools(), assistantMessage: root.assistantMessage,
        context: { messages: root.messages, tools: this.callableTools() }, signal,
        beforeToolCall: ({ args }) => this.runner.emitToolCall({ type: "tool_call", ...event, input: args }),
        afterToolCall: ({ args, result, isError }) => this.runner.emitToolResult({ type: "tool_result", ...event,
          input: args, content: result.content, details: result.details, structuredContent: result.structuredContent,
          usage: result.usage, isError }),
        onUpdate: async partialResult => {
          if (signal.aborted) return;
          await options.onUpdate?.(partialResult);
          await this.emit({ type: "tool_execution_update", ...event, args: toolCall.arguments, partialResult });
        },
      });
      if (record) {
        record.status = outcome.isError ? "error" : "ok";
        record.durationMs = Math.round(performance.now() - started);
        if (outcome.isError) record.error = outcome.result.content.filter(part => part.type === "text")
          .map(part => part.text).join("\n").slice(0, NESTED_LIMITS.errorChars);
      }
      if (outcome.result.usage) root.usage = addToolUsage(root.usage, outcome.result.usage);
      await this.emit({ type: "tool_execution_end", ...event, result: outcome.result, isError: outcome.isError });
      return outcome;
    } finally {
      this.scopes.delete(toolCall.id);
      if (record?.status === "unfinished") root.complete = false;
      release?.();
    }
  }
}
