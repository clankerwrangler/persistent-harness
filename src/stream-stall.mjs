// A provider stream can go silent without closing (a dead socket mid-response),
// which would hold the turn and its queued input forever. Fail the attempt
// instead, with text the stock retry classifier treats as a transient timeout.
export const STREAM_STALL_MS = 10 * 60_000;

export class StreamStallError extends Error {
  constructor(stallMs) {
    super(`provider stream stalled: no data for ${Math.round(stallMs / 1000)}s (timed out)`);
    this.code = "ERR_PROVIDER_STREAM_STALLED";
  }
}

export async function* watchStreamStall(stream, stallMs, onStall) {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = iterator.next();
      next.catch(() => {});
      let timer;
      const stalled = new Promise((_, reject) => { timer = setTimeout(() => reject(new StreamStallError(stallMs)), stallMs); });
      let result;
      try { result = await Promise.race([next, stalled]); }
      catch (error) { if (error instanceof StreamStallError) onStall(error); throw error; }
      finally { clearTimeout(timer); }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // A stalled provider may never settle its pending read; do not wait for it.
    Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}
