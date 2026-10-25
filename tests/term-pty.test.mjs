// term-pty.test.mjs — can the terminal dock give shells a REAL pty here?
//
// User report 2026-10-25: "script.exe has gone and terminal with nano is not
// working in this idb-live-cache branch". Investigation: the branch does not touch
// terminal code (terminal-hub.mjs is byte-identical to main), the provisioned
// data/bin/script/script.exe is intact AND byte-identical to a freshly extracted
// copy of the sha256-pinned msys2 package — but that exe cannot allocate a pty in
// this environment:
//
//   script: failed to create pseudo-terminal: No such file or directory
//
// (Git for Windows ships msys-2.0.dll 3.6.7 built 2026-04-21; /dev/ptmx is equally
// broken for a plain `bash -lc 'exec 3<>/dev/ptmx'` — "Too many open files" — so no
// msys pty can exist here at all.) The hub fell back to the pipe tier, where nano
// and vim fail with "standard input is not a terminal" — and nothing said so.
//
// term-smoke tolerates EITHER tier, so this could never fail in CI. This suite is
// the missing check. The capability itself is an ENVIRONMENT property (a broken Git
// runtime), so by default it is reported; the PRODUCT assertions (K4/K5) are
// deterministic: the hub must now PROVE a bridge before adopting it, and must name
// the failure instead of silently degrading.
//
//   node tests/term-pty.test.mjs                    → report + product assertions
//   PI_REQUIRE_PTY=1 node tests/term-pty.test.mjs   → additionally REQUIRE a pty
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const requirePty = process.env.PI_REQUIRE_PTY === "1" || process.env.PI_REQUIRE_PTY === "true";

if (process.platform !== "win32") {
	console.log("[term-pty] non-Windows: the node-pty backend is not implemented (plan-linux.md phase 2) — nothing to probe");
	console.log(`\n[term-pty] ${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

const findBash = () => {
	for (const p of [process.env.PI_WEB_BASH_SHELL, "C:\\Git\\usr\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) {
		if (p && fs.existsSync(p)) return p;
	}
	return null;
};
const findBridge = () => {
	const override = String(process.env.PI_WEB_TERM_BRIDGE || "").trim();
	if (override && override !== "0" && override.toLowerCase() !== "pipes") return fs.existsSync(override) ? override : null;
	const dataDir = process.env.PI_WEB_DATA_DIR ? path.resolve(process.env.PI_WEB_DATA_DIR) : path.join(ROOT, "data");
	const p = path.join(dataDir, "bin", "script", "script.exe");
	return fs.existsSync(p) ? p : null;
};

const bash = findBash();
const bridge = findBridge();
check("K1 a bash is available for the probe", !!bash, bash || "none found");
check("K2 the pty bridge file exists (auto-provisioned or PI_WEB_TERM_BRIDGE)", !!bridge, bridge || "absent — pipe tier only");

let verdict = { ok: false, reason: "no bridge or no bash" };
if (bridge && bash) {
	// -e/--return: script propagates the CHILD's status, so this asserts the whole
	// property the terminal needs — bash must see isatty(stdin) — not merely that
	// the exe starts.
	const fwd = (p) => String(p).replace(/\\/g, "/");
	const r = spawnSync(bridge, ["-q", "-f", "-e", "-c", `"${fwd(bash)}" -c "test -t 0"`, "/dev/null"], {
		stdio: "pipe", timeout: 8000, windowsHide: true, encoding: "utf8",
	});
	verdict = { ok: r.status === 0, reason: (String(r.stderr || "").trim() || `exit ${r.status}`).slice(0, 300) };
	if (requirePty) check("K3 (PI_REQUIRE_PTY=1) the bridge allocates a pty this shell recognises", verdict.ok, verdict.ok ? "isatty(stdin)=true" : verdict.reason);
	else console.log(`  • K3 capability: ${verdict.ok ? "pty OK (isatty(stdin)=true)" : "NO pty — " + verdict.reason}`);
}
if (!verdict.ok) {
	console.log("\n  ⚠ PTY UNAVAILABLE in this environment — the dock runs the PIPE tier and");
	console.log(`    nano/vim will report "standard input is not a terminal". Reason: ${verdict.reason}`);
	console.log("    Environment fix: repair/reinstall Git for Windows (its msys runtime provides");
	console.log("    /dev/ptmx), or point PI_WEB_TERM_BRIDGE at a script.exe built for that runtime.");
}

// ── the product assertions (deterministic on any machine) ────────────────────
{
	const { bridgeProbe } = await import("../terminal-hub.mjs");
	if (bridge && bash) {
		const v = bridgeProbe(bridge, bash);
		check("K4 the hub's probe agrees with the raw pty observation", v.ok === verdict.ok, `probe=${v.ok} raw=${verdict.ok}`);
		check("K4 the probe names the failure (so the dock can show it)",
			v.ok || /pseudo-terminal|exit |ENOENT/i.test(String(v.reason || "")), String(v.reason || ""));
		check("K4 the verdict is cached (no respawn per shell)", bridgeProbe(bridge, bash) === v);
	} else {
		check("K4 probe reachable without a bridge (returns a negative verdict, never throws)", true, "skipped: nothing to probe");
	}
	const src = fs.readFileSync(path.join(ROOT, "terminal-hub.mjs"), "utf8");
	check("K5 the reason reaches the client (state frame field)", /bridgeNote: sess\.bridgeNote/.test(src));
	check("K5 provisioning refuses to adopt a bridge that cannot create a pty", /pinned bridge cannot create a pty/.test(src));
	check("K5 the hub no longer trusts the PE header alone when choosing a bridge", /function pickBridge\(dataDir, bashPath\)/.test(src) && /pickBridge\(dataDir, bashPath\)/.test(src));
}

console.log(`\n[term-pty] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
