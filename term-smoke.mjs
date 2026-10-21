#!/usr/bin/env node
/**
 * term-smoke.mjs — end-to-end smoke test for /ws/terminal (terminal-hub.mjs).
 *
 * Boots a REAL server on a scratch port, then over a raw WebSocket:
 *   1. cross-origin dial (Origin http://evil.example) → must be rejected (403)
 *   2. guessable session id ("main") → must be closed (4000)
 *   3. happy path: attach → state frame (reports tier) → run `echo …` → output
 *      round-trips through the shell
 *   4. replay: a SECOND socket with the same id receives the history
 *   5. reset: kill + respawn → new prompt output arrives
 *
 * Usage: node term-smoke.mjs   (spawns + kills its own server on :8789)
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// random scratch port: leftover listeners from a previous crashed run must not
// fail the whole suite (a stale 8789 did exactly that once)
const PORT = 8790 + Math.floor(Math.random() * 500);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const GOOD_ID = "smoke0123456789abcdef0123456789ef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, ok, extra = "") {
	if (ok) {
		passed++;
		console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`);
	}
}

function killTree(pid) {
	try {
		spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
	} catch {
		/* ignore */
	}
}

/** Open a terminal WS and collect frames until `done` says stop. */
function openTerminal({ id = GOOD_ID, origin = ORIGIN, timeoutMs = 20000 } = {}) {
	return new Promise((resolve, reject) => {
		const frames = [];
		const state = { opened: false, closeCode: null, rejectReason: null, tier: null, phase: null };
		let openError = null;
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?session=${id}`, { origin });
		const timer = setTimeout(() => finish("timeout"), timeoutMs);
		const finish = (why) => {
			clearTimeout(timer);
			try { ws.close(); } catch { /* ignore */ }
			resolve({ frames, state, why, openError });
		};
		ws.on("unexpected-response", (_req, res) => {
			state.rejectReason = res.statusCode;
			finish(`HTTP ${res.statusCode}`);
		});
		ws.on("error", (err) => {
			openError = err;
			if (!state.opened) finish("socket error: " + err.message);
		});
		ws.on("open", () => {
			state.opened = true;
			resolve({
				frames,
				state,
				why: "open",
				openError: null,
				send: (obj) => ws.send(JSON.stringify(obj)),
				rawSend: (s) => ws.send(s),
				close: () => finish("client close"),
				waitFor: async (pred, ms = 12000) => {
					const t0 = Date.now();
					for (;;) {
						const hit = frames.find(pred);
						if (hit) return hit;
						if (Date.now() - t0 > ms) return null;
						await sleep(50);
					}
				},
			});
		});
		ws.on("close", (code) => {
			state.closeCode = code;
			if (!state.opened && !openError) finish(`closed pre-open (${code})`);
		});
		ws.on("message", (raw) => {
			try {
				const m = JSON.parse(raw.toString());
				frames.push(m);
				if (m.t === "state" && m.s) {
					state.tier = m.s.tier;
					state.phase = m.s.phase;
					state.error = m.s.error;
				}
			} catch {
				/* ignore */
			}
		});
	});
}

async function main() {
	console.log(`[smoke] booting server on :${PORT} …`);
	const server = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
		env: { ...process.env, PORT: String(PORT), PI_WEB_PORT: String(PORT), PI_WEB_DEBUG: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let serverLog = "";
	server.stdout.on("data", (d) => (serverLog += d));
	server.stderr.on("data", (d) => (serverLog += d));
	try {
		// wait for the HTTP listener
		let up = false;
		for (let i = 0; i < 60 && !up; i++) {
			await sleep(250);
			up = serverLog.includes("serving") || serverLog.includes("[pi-web] open");
		}
		if (!up) throw new Error("server did not boot:\n" + serverLog.slice(-2000));
		console.log("[smoke] server up");

		// 1) cross-origin dial must fail
		{
			const r = await openTerminal({ origin: "http://evil.example:80" });
			check("cross-origin WS rejected", r.why !== "open" && (r.state.rejectReason === 403 || String(r.openError).includes("403")), `why=${r.why}`);
		}

		// 2) guessable session id must be closed with 4000 (the server closes right
		// after the upgrade — poll briefly; the close frame races the open event)
		{
			const r = await openTerminal({ id: "main" });
			let code = r.state.closeCode;
			for (let i = 0; i < 20 && code === null; i++) {
				await sleep(100);
				code = r.state.closeCode;
			}
			check("guessable session id rejected", code === 4000, `close=${code}`);
		}

		// 3) happy path (default tier = pipes; readline echoes + renders prompts)
		let conn;
		{
			conn = await openTerminal({});
			check("terminal attached", conn.why === "open");
			const st = await conn.waitFor((m) => m.t === "state" && (m.s.phase === "ready" || m.s.phase === "error" || m.s.phase === "dead"));
			check("shell reached a phase", !!st, `tier=${conn.state.tier} phase=${conn.state.phase} err=${conn.state.error || "-"}`);
			check("tier is pty (msys bridge) or pipes (fallback — bridge provisioning is async)",
				conn.state.tier === "pipes" || conn.state.tier === "pty", `tier=${conn.state.tier}`);
			const prompt = await conn.waitFor((m) => (m.t === "d" || m.t === "replay") && String(m.d || "").includes("$"), 8000);
			check("first prompt reaches the client (not swallowed by the noise filter)", !!prompt);
			conn.send({ t: "i", d: "echo TERM_SMOKE_$((41+1))\r" });
			const out = await conn.waitFor((m) => (m.t === "d" || m.t === "replay") && String(m.d || "").includes("TERM_SMOKE_42"));
			check("echo round-trip through the shell", !!out, `tier=${conn.state.tier}`);
			// ONLCR regression: bare \n in the stream makes the emulator keep the
			// column → staircase cursor offset after Enter (user-reported bug)
			const allData = conn.frames
				.filter((m) => m.t === "d" || m.t === "replay")
				.map((m) => String(m.d ?? ""))
				.join("");
			check("ONLCR: every \n reaches the emulator as \r\n (no cursor staircase)", !/(^|[^\r])\n/.test(allData));
		}

		// 4) replay on second attach
		{
			const second = await openTerminal({});
			const rep = await second.waitFor((m) => m.t === "replay" && String(m.d || "").includes("TERM_SMOKE_42"));
			check("ring replay on reattach", !!rep);
			await second.close();
		}

		// 5) reset respawns
		{
			conn.send({ t: "reset" });
			const out = await conn.waitFor((m) => (m.t === "d" || m.t === "replay") && String(m.d || "").includes("TERM_SMOKE_43"), 15000);
			conn.send({ t: "i", d: "echo TERM_SMOKE_43\r" });
			const out2 = await conn.waitFor((m) => (m.t === "d" || m.t === "replay") && String(m.d || "").includes("TERM_SMOKE_43"), 15000);
			check("shell alive after reset", !!(out || out2), "reset→respawn→echo ok");
		}

		// 6) Exit button semantics: {t:"kill"} ends the shell WITHOUT respawn
		{
			conn.send({ t: "kill" });
			const dead = await conn.waitFor((m) => m.t === "state" && m.s.phase === "dead", 8000);
			check("kill frame ends the shell (no respawn)", !!dead, `phase=${conn.state.phase}`);
			// and it stays dead (no auto-respawn)
			await sleep(700);
			const stillDead = !conn.frames.some((m) => m.t === "state" && m.s.phase === "ready" && conn.frames.indexOf(m) > conn.frames.indexOf(dead ?? m));
			check("shell stays dead after kill", stillDead);
		}

		await conn.close();
	} catch (err) {
		failed++;
		console.error("[smoke] FATAL:", err?.message || err);
		if (serverLog) console.error("---- server log tail ----\n" + serverLog.slice(-1500));
	} finally {
		killTree(server.pid);
		await sleep(400);
	}
	console.log(`\n[smoke] ${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

main();
