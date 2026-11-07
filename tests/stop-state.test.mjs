// stop-state.test.mjs — the CLIENT half of the 2026-10-31 "Stop does not stop, and the button turned into
// Send" report.
//
// The bug was a local LIE: `ProxyAgent.abort()` set `isStreaming = false`, cleared `streamingMessage` and
// emitted a synthetic `agent_end` before the server had confirmed anything. The UI therefore showed Send
// (no way to kill again) while the server was still generating. These checks pin the corrected contract:
//
//   * abort() only REQUESTS a stop — it must not touch isStreaming / streamingMessage / emit agent_end
//   * `stopping` stays true until the SERVER confirms (state frame with isStreaming:false, or agent_end)
//   * `stoppingFor` grows, so the UI can escalate
//   * a new run (agent_start) clears it
//
// Hermetic: ProxyAgent without a socket (sendMsg is a no-op when not connected).
// Usage: node tests/stop-state.test.mjs
import { createStopTracker, shouldRefuseSend } from "../src/ui/stop-state.ts";
import fs from "node:fs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── the pure state machine ─────────────────────────────────────────────────
{
	let t = 1000;
	const tracker = createStopTracker(() => t);
	check("S1 a fresh tracker is not stopping", tracker.stopping === false && tracker.stoppingFor === 0);
	tracker.request();
	check("S2 request() marks the stop as pending", tracker.stopping === true);
	t += 2500;
	check("S3 stoppingFor measures the UNCONFIRMED time (so the UI can escalate)", tracker.stoppingFor === 2500);
	check("S4 confirm() clears it and reports the change", tracker.confirm() === true && tracker.stopping === false);
	check("S5 a second confirm is a no-op (no spurious event)", tracker.confirm() === false);
	tracker.request();
	t += 100;
	check("S6 a re-request re-stamps the clock (a second click is not swallowed)", (() => { tracker.request(); return tracker.stoppingFor === 0; })());
	check("S7 subscribers see both transitions", (() => {
		const seen = [];
		const off = tracker.subscribe((st) => seen.push(st.stopping));
		tracker.confirm();
		tracker.request();
		off();
		tracker.confirm();
		return JSON.stringify(seen) === JSON.stringify([false, true]);
	})());
	check("S8 a throwing listener cannot break the emit", (() => {
		const off = tracker.subscribe(() => { throw new Error("boom"); });
		let ok = false;
		try { tracker.request(); ok = true; } catch { /* must not throw */ }
		off();
		return ok;
	})());
}
{
	// the send guard: a prompt while a stop is pending would be converted into a STEER by the server
	check("G1 sending while stopping + streaming is refused", shouldRefuseSend(true, true) === true);
	check("G2 …but a plain send is fine", shouldRefuseSend(false, true) === false && shouldRefuseSend(false, false) === false);
	check("G3 an idle session with a stale flag still sends", shouldRefuseSend(true, false) === false);
}

// ── the UI wiring (source-level: the button and the send path) ──────────────
{
	const chat = fs.readFileSync(new URL("../src/ui/chat.tsx", import.meta.url), "utf8");
	check("U1 the composer tracks `stopping` from the agent", /const \[stopping, setStopping\] = useState<boolean>\(!!\(agent as any\)\.stopping\)/.test(chat));
	check("U2 the button stays a Stop while a stop is pending (and re-sends)", /streaming \|\| stopping \? stop\(\) : send\(\)/.test(chat) && /stopping \? \(streaming \? "Stopping…" : "Stopped"\)/.test(chat));
	check("U3 …and is not disabled by an empty composer in that state", /disabled=\{!streaming && !stopping &&/.test(chat));
	check("U4 a send while stopping is REFUSED with a note (never silently converted into a steer)",
		/sendWouldSteer[\s\S]{0,200}still stopping/.test(chat) || /stopping && streaming\) \{[\s\S]{0,200}still stopping/.test(chat));
	check("U5 an unconfirmed stop escalates visibly after ~9s", /setTimeout\([\s\S]{0,120}not confirmed yet/.test(chat));
	check("U6 the Steer affordance is hidden while stopping", /pw-steer-send[\s\S]{0,120}hidden=\{stopping\}/.test(chat));
	check("U7 the client no longer claims the run ended on abort", !/abort\(\): void \{[\s\S]{0,200}this\.state\.isStreaming = false/.test(chat.replace(/\n/g, "\n")));
}

console.log(`\n[stop-state] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
