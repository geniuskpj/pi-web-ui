// idb-cache.test.mjs — C1: the IDB cache's GENERATION model (schema v2).
//
// The IDB layer itself needs a browser, but every decision that matters is a pure
// function exported by src/idb-cache.ts (Node imports the .ts directly — type
// stripping), so it can be pinned here:
//   - key/naming: a chunk key carries the GENERATION (rewriteSeq), so a rewrite
//     makes the old data unreachable instead of erasing it;
//   - mergeRanges: coverage stays disjoint and 1:1 with chunk keys, an
//     overlapping window replaces the older range (the seam case);
//   - pickSweepCandidates: superseded generations go after an idle grace period,
//     anything goes after a hard TTL (date GC — "don't erase immediately");
//   - verifyChunkText: integrity check used on read (bad chunk → refetch);
//   - plus source assertions for the two behavioural requirements that cannot be
//     expressed as a pure call: NO invalidate-and-wipe anywhere, and the v2 keys.
// Usage: node tests/idb-cache.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { intervalDiff, chunkKey, mergeRanges, pickSweepCandidates, verifyChunkText } from "../src/idb-cache.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const disjoint = (rs) => rs.every((r, i) => i === 0 || rs[i - 1].toSeq <= r.fromSeq);

// ───────────────────────────────────────────────────── keys / generations (K)
{
	const a = chunkKey("s1", 3, 128);
	const b = chunkKey("s1", 4, 128);
	check("K1 a chunk key carries the generation", a.join(":") === "s1:3:128" && b.join(":") === "s1:4:128" && a.join(":") !== b.join(":"),
		`${a.join(":")} vs ${b.join(":")}`);
	check("K2 key is an array triple (compound keyPath shape)",
		Array.isArray(a) && a.length === 3 && typeof a[0] === "string" && typeof a[1] === "number" && typeof a[2] === "number");
}

// ───────────────────────────────────────────────────────── coverage math (M)
{
	check("M1 no coverage → the whole window is a hole",
		JSON.stringify(intervalDiff(0, 100, [])) === JSON.stringify([{ fromSeq: 0, toSeq: 100 }]));
	check("M2 fully covered → no holes", intervalDiff(0, 100, [{ fromSeq: 0, toSeq: 100 }]).length === 0);
	check("M3 head and tail holes are reported",
		JSON.stringify(intervalDiff(0, 100, [{ fromSeq: 20, toSeq: 60 }])) === JSON.stringify([{ fromSeq: 0, toSeq: 20 }, { fromSeq: 60, toSeq: 100 }]));
	check("M4 adjacent ranges are not a hole", intervalDiff(0, 100, [{ fromSeq: 0, toSeq: 40 }, { fromSeq: 40, toSeq: 100 }]).length === 0);

	// the seam case: an unaligned fetched window meets a new aligned one
	const first = mergeRanges([], { fromSeq: 700, toSeq: 780, bytes: 1000 });
	check("M5 first put is a single range", first.ranges.length === 1 && first.replaced.length === 0 && first.ranges[0].bytes === 1000);

	const overlap = mergeRanges(first.ranges, { fromSeq: 760, toSeq: 820, bytes: 900 });
	check("M6 an overlapping window REPLACES the older range (no merged range)",
		overlap.replaced.length === 1 && overlap.replaced[0].fromSeq === 700 &&
		JSON.stringify(overlap.ranges.map((r) => [r.fromSeq, r.toSeq])) === JSON.stringify([[760, 820]]) &&
		disjoint(overlap.ranges));
	check("M6b replaced ranges are exactly what the caller must delete",
		overlap.replaced.every((r) => ![760].includes(r.fromSeq)));

	const rePut = mergeRanges([{ fromSeq: 100, toSeq: 164, bytes: 500 }], { fromSeq: 100, toSeq: 164, bytes: 480 });
	check("M7 re-putting the same window keeps ONE range and swaps the byte count",
		rePut.ranges.length === 1 && rePut.ranges[0].bytes === 480 && rePut.replaced.length === 1);

	const swallow = mergeRanges([{ fromSeq: 10, toSeq: 20 }, { fromSeq: 20, toSeq: 30 }, { fromSeq: 90, toSeq: 95 }], { fromSeq: 0, toSeq: 30 });
	check("M8 a window covering two ranges replaces both and keeps the untouched third",
		swallow.replaced.length === 2 && JSON.stringify(swallow.ranges.map((r) => [r.fromSeq, r.toSeq])) === JSON.stringify([[0, 30], [90, 95]]) && disjoint(swallow.ranges));

	const multi = mergeRanges([{ fromSeq: 0, toSeq: 10 }, { fromSeq: 50, toSeq: 60 }], { fromSeq: 20, toSeq: 30 });
	check("M9 disjoint adds stay sorted + disjoint", JSON.stringify(multi.ranges.map((r) => r.fromSeq)) === JSON.stringify([0, 20, 50]) && multi.replaced.length === 0 && disjoint(multi.ranges));
}

// ──────────────────────────────────────────────────────────── the GC sweep (S)
{
	const now = 1_000_000_000;
	const metas = [
		{ sessionId: "s1", rewriteSeq: 5, updatedAt: now - 60_000 }, // current gen, fresh
		{ sessionId: "s1", rewriteSeq: 4, updatedAt: now - 60_000 }, // superseded, inside the grace period
		{ sessionId: "s1", rewriteSeq: 3, updatedAt: now - 10 * 60_000 }, // superseded + aged → collect
		{ sessionId: "s2", rewriteSeq: 0, updatedAt: now - 40 * 24 * 3600_000 }, // beyond the hard TTL → collect
		{ sessionId: "s2", rewriteSeq: 1, updatedAt: now - 1000 }, // current gen of s2, fresh
	];
	const opts = { now, maxAgeMs: 5 * 60_000, hardTtlMs: 30 * 24 * 3600_000 };
	const picked = pickSweepCandidates(metas, opts).map((t) => `${t.sessionId}@${t.rewriteSeq}:${t.reason}`).sort();
	check("S1 superseded+aged and hard-TTL-expired are collected, current + fresh are not",
		JSON.stringify(picked) === JSON.stringify(["s1@3:superseded", "s2@0:expired"]), picked.join(", "));
	check("S2 the grace period protects a just-superseded generation",
		!pickSweepCandidates(metas, opts).some((t) => t.sessionId === "s1" && t.rewriteSeq === 4));
	check("S3 a session filter limits the sweep to that session",
		pickSweepCandidates(metas, { ...opts, sessionId: "s2" }).length === 1);
	check("S4 the CURRENT generation is never collected on age alone (only the hard TTL)",
		!pickSweepCandidates(metas, opts).some((t) => t.sessionId === "s2" && t.rewriteSeq === 1));
	// A record with no/zero timestamp reads as age = now (the conservative
	// direction): harmless inside the hard TTL, expired beyond it.
	const noTsYoung = pickSweepCandidates([{ sessionId: "s3", rewriteSeq: 0 }], { ...opts, now: 60_000 });
	check("S5 a record without updatedAt is NOT collected while now is still inside the hard TTL", noTsYoung.length === 0);
	const noTsOld = pickSweepCandidates([{ sessionId: "s3", rewriteSeq: 0, updatedAt: 0 }], { ...opts, now: opts.hardTtlMs + 1 });
	check("S5b beyond the hard TTL even an untimestamped record is expired", noTsOld.length === 1 && noTsOld[0].reason === "expired");
}

// ──────────────────────────────────────────────────────────── integrity check (I)
{
	const line = (i) => JSON.stringify({ role: "user", content: "m" + i });
	check("I1 a correct window passes", verifyChunkText([0, 1, 2].map(line).join("\n"), 0, 3).ok === true);
	check("I2 a short body fails with the count", (() => { const v = verifyChunkText([0, 1].map(line).join("\n"), 0, 3); return v.ok === false && /line count 2 != window 3/.test(v.reason || ""); })());
	check("I3 a non-JSON line fails", verifyChunkText([line(0), "not json", line(2)].join("\n"), 0, 3).ok === false);
	check("I4 an empty body is only valid for an empty window", verifyChunkText("", 0, 0).ok === true && verifyChunkText("", 0, 1).ok === false);
}

// ─────────────────────────────────────── source invariants (no wipe, v2 keys) (R)
{
	const cacheSrc = fs.readFileSync(path.join(ROOT, "src/idb-cache.ts"), "utf8");
	const proxySrc = fs.readFileSync(path.join(ROOT, "src/proxy-agent.ts"), "utf8");
	check("R1 invalidateSession (the wipe-on-rewrite path) is GONE from the cache module",
		!/export async function invalidateSession/.test(cacheSrc) && /export async function sweepStale/.test(cacheSrc));
	check("R2 no caller invokes an invalidate/wipe on an epoch mismatch",
		!/invalidateSession/.test(proxySrc) && /sweepStale\(\{ sessionId: this\.sessionId \}\)/.test(proxySrc));
	check("R3 schema is v2 with generation-bearing compound keys",
		/DB_VERSION = 2/.test(cacheSrc) && /keyPath: \["sessionId", "rewriteSeq", "fromSeq"\]/.test(cacheSrc) && /keyPath: \["sessionId", "rewriteSeq"\]/.test(cacheSrc));
	check("R4 putChunk drops writes for an OLDER generation (no resurrection after a sweep)",
		/rewriteSeq < known\) return;/.test(cacheSrc));
	check("R4b the v1→v2 upgrade DELETES the old stores (a keyPath cannot change in place)",
		/oldVersion \|\| 0/.test(cacheSrc) && /from < 2/.test(cacheSrc) && /deleteObjectStore\(name\)/.test(cacheSrc));
	check("R5 the read path verifies integrity and drops a bad chunk instead of rendering it",
		/verifyChunkText\(text, r\.fromSeq, r\.toSeq\)/.test(cacheSrc) && /dropChunk\(sessionId, gen, r\.fromSeq\)/.test(cacheSrc));
}

console.log(`\n[idb-cache] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
