// arena-timeline-bridge.mjs — a FAKE arena bridge for tests/arena-peer.test.mjs.
//
// It records a timeline (enter/exit per call) to the file in PI_TEST_ARENA_LOG, so the test can compute
// how many calls were in the browser tab at the same time. Generating this module from a template string
// inside the test was a source of escaping bugs; a real file can be syntax-checked and read.
import { appendFileSync } from "node:fs";

const log = process.env.PI_TEST_ARENA_LOG || "";
const mark = (what, extra = {}) => {
	if (!log) return;
	appendFileSync(log, JSON.stringify({ what, at: Date.now(), ...extra }) + "\n");
};

export async function listModels() {
	return [{ id: "uuid-grok", publicName: "grok-4.6-high", displayName: "grok-4.6-high", userSelectable: true }];
}

export async function chat(message, slug, modelId) {
	const text = String(message);
	mark("enter", { message: text.slice(0, 10) });
	// "HANG" outlives the test's 250ms timeout, so the timeout path is exercised on purpose
	await new Promise((r) => setTimeout(r, text.includes("HANG") ? 700 : 40));
	mark("exit", { message: text.slice(0, 10) });
	return { text: `OK ${text.slice(0, 10)}`, routedModel: `xai/${slug}`, convId: "c1" };
}
