// tests/_wait.mjs — provider-aware waits for the end-to-end suites.
//
// A hub test that waits for a REAL model turn is bounded by the LLM endpoint, whose
// first-token latency swings from ~2s to >100s (measured on the same prompt, same minute,
// provider batching under load). Suites that hardcoded 15–20s therefore reported failures
// for runs that were merely still in flight — the structural assertions next to them passed.
//
// Use MODEL_WAIT_MS for "the model should have answered by now" and FAST_WAIT_MS for
// socket/state/JSONL waits that never touch the provider.
export const MODEL_WAIT_MS = Number(process.env.PI_TEST_TIMEOUT_MS || 240000);
export const FAST_WAIT_MS = Number(process.env.PI_TEST_FAST_MS || 15000);

/** Poll `fn` until it returns truthy or `ms` elapses. Returns the last value. */
export async function waitUntil(fn, ms = MODEL_WAIT_MS, step = 400) {
	const t0 = Date.now();
	let last;
	for (;;) {
		try { last = await fn(); } catch { /* keep polling */ }
		if (last) return last;
		if (Date.now() - t0 > ms) return last;
		await new Promise((r) => setTimeout(r, step));
	}
}
