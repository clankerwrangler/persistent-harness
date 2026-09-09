# Asynchronous execution

Ordinary tools use a terminal-response barrier. The native path can start a fully completed Python call while the provider response is still streaming, then continue inference or steering while Python remains pending.

Enable the native policy with `PI_HARNESS_NATIVE_ASYNC=1`. The current policy specifically admits `openai-codex/gpt-6-astra` on `openai-codex-responses` with `model.compat.supportsAsyncTools === true`. The tool definition must opt in, the effective outgoing request must advertise it, and the actual completed raw provider item must return its async opt-in. A serialized `async` property or a partial event alone is not proof. Other models continue through ordinary execution; this switch does not make an unsupported provider asynchronous.

The adapter owns raw SSE or header-capable WebSocket transport and composes the unmodified stock public Responses parser. Complete calls are admitted in source order, even if item-completion events arrive out of order. A source prefix is durable before execution; a late reasoning backfill becomes selected canonical metadata rather than a rewritten prefix. Open text keeps its identity across prefix segmentation.

Python execution remains FIFO. `wait_for_ipython` is an ordinary barrier that hands control back when original results are available; it does not submit duplicate code or manufacture a result. An early result does not imply that the namespace checkpoint has finished. Later Python calls, reload, and graceful shutdown still obey the kernel's save tail.

Cancellation fences the inference generation and cancels queued/active work with original-ID outcomes. After a crash, an uncertain operation is not automatically replayed.

An unexplained post-send transport loss is an unknown inference outcome, including possible provider processing and usage. Automatic inference retry is allowed only under the explicit policy when the old generation is fenced, no local calls were admitted or dispatched, and no provider-side tools could have executed. The original unknown record remains. This does not promise exactly-once server inference or cancellation of a remote request.

Validation uses synthetic providers and real local Python. Live endpoint/auth compatibility must be verified separately in the intended deployment; no live-provider verification is implied by the repository's test results.
