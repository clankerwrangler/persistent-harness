import { randomUUID } from "node:crypto";
import net from "node:net";
import { JsonLineDecoder, encodeFrame } from "./framing.mjs";
import { PROTOCOL_VERSION, validateServerFrame } from "./protocol.mjs";

export function controlRequest(socketPath, type, params = {}, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(socketPath);
    const decoder = new JsonLineDecoder();
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${type} request timed out`)), timeoutMs);

    function finish(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    }

    socket.on("connect", () => {
      socket.write(encodeFrame({ version: PROTOCOL_VERSION, id, type, params }));
    });
    socket.on("data", (chunk) => {
      try {
        for (const rawFrame of decoder.push(chunk)) {
          const frame = validateServerFrame(rawFrame);
          if (frame.type === "protocol_error") return finish(new Error(`${frame.code}: ${frame.message}`));
          if (frame.type !== "response" || frame.id !== id) continue;
          if (!frame.ok) return finish(new Error(frame.error));
          return finish(undefined, frame.data);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error("connection closed before a response"));
    });
  });
}
