// The caller must first pass the kernel's exact manifest host-request grant check.
const PREFIX = "extension_tool.";
const MAX_RESULT_BYTES = 512 * 1024;

function boundedJSON(value) {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error("native outcome exceeds the 512 KiB JSON boundary");
  return JSON.parse(json);
}

export async function dispatchExtensionTool(requestType, arguments_, { toolContext, signal, onProgress } = {}) {
  const name = requestType.slice(PREFIX.length);
  if (!requestType.startsWith(PREFIX) || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new Error("invalid exact extension tool operation");
  if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) throw new Error("extension tool arguments must be an object");
  if (typeof toolContext?.executeTool !== "function") throw new Error("extension tools require a live tool-owned Python cell");
  if (signal?.aborted) throw new Error("extension tool request cancelled before dispatch; it did not run");
  const outcome = await toolContext.executeTool(name, arguments_, { signal, onUpdate: partial => {
    // Native structured updates also flow through the coordinator's tool events.
    const text = (partial.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
    if (text) onProgress?.("stdout", `${text}\n`);
  } });
  try { return boundedJSON(outcome); }
  catch { throw new Error("Extension tool completed, but its native outcome could not be returned within the 512 KiB JSON boundary. Side effects may have occurred; do not retry automatically."); }
}
