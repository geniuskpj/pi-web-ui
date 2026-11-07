// stop-state.ts — "a Stop was sent and the SERVER has not confirmed it yet". Pure, so the awkward part is
// testable without a browser or a socket.
//
// WHY (user report 2026-10-31): the client used to treat Stop as a local verdict — it cleared isStreaming
// and emitted a synthetic agent_end the moment the button was clicked. When the server did NOT actually
// stop (a wedged run, or simply a few seconds of latency), the UI showed Send while generation continued,
// and there was no button left to kill it with. The honest model is a two-phase one:
//
//   request()  the user asked to stop  → stopping = true  (the UI keeps a Stop button, and re-sends)
//   confirm()  the SERVER said it ended (state frame with isStreaming:false, agent_end, or a new run)
//
// `stoppingFor` exists so the UI can escalate (a note, a different label) instead of pretending.

export type StopState = { stopping: boolean; stoppingFor: number };
export type StopListener = (state: StopState) => void;

export function createStopTracker(now: () => number = Date.now) {
	let requestedAt = 0;
	const listeners = new Set<StopListener>();

	const state = (): StopState => ({ stopping: requestedAt > 0, stoppingFor: requestedAt ? Math.max(0, now() - requestedAt) : 0 });
	const emit = () => {
		const s = state();
		for (const l of [...listeners]) { try { l(s); } catch { /* a listener must not break the socket */ } }
	};

	return {
		/** The user pressed Stop. Idempotent; a second press just re-stamps (the server debounces its own). */
		request() { requestedAt = now(); emit(); return true; },
		/** The server confirmed the run is over (or a new one started). Returns whether anything changed. */
		confirm() { if (!requestedAt) return false; requestedAt = 0; emit(); return true; },
		get stopping() { return requestedAt > 0; },
		get stoppingFor() { return requestedAt ? Math.max(0, now() - requestedAt) : 0; },
		state,
		subscribe(l: StopListener) { listeners.add(l); return () => { listeners.delete(l); }; },
		/** Test seam. */
		_reset() { requestedAt = 0; listeners.clear(); },
	};
}

export type StopTracker = ReturnType<typeof createStopTracker>;

/** Should a send be refused because a stop is still unconfirmed? (a prompt now would become a STEER) */
export const shouldRefuseSend = (stopping: boolean, streaming: boolean) => stopping && streaming;
