#!/usr/bin/env node
/**
 * vendor-wterm.mjs — download the PREBUILT wterm dist from npm and bundle it
 * into a single self-contained ESM file under public/vendor/wterm/.
 *
 * Why: the terminal must work without any runtime CDN dependency (LAN/offline)
 * and without node-pty/native builds. wterm (@wterm/dom + @wterm/core) ships
 * as prebuilt ESM with the ~26KB Zig WASM core inlined as base64 — esbuild only
 * concatenates it (the one bare `@wterm/core` import is aliased to the vendored
 * copy); nothing is compiled from source.
 *
 * Output (checked in):
 *   public/vendor/wterm/wterm.js       single ESM bundle (lazy-imported)
 *   public/vendor/wterm/terminal.css   wterm's stylesheet (linked in index.html)
 *
 * Usage: node vendor-wterm.mjs [--check]
 *   --check: exit 0 if the outputs exist and match the pinned versions' sizes
 *            (cheap freshness probe for CI), exit 1 otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "public", "vendor", "wterm");

const WTERM_VERSION = "0.5.4";
const PKGS = [
	{ name: "@wterm/dom", version: WTERM_VERSION },
	{ name: "@wterm/core", version: WTERM_VERSION },
];

function npmTarballUrl(name, version) {
	// @wterm/dom → @wterm/dom/-/dom-0.5.4.tgz (registry scoped tarball layout)
	const short = name.split("/")[1];
	return `https://registry.npmjs.org/${name}/-/${short}-${version}.tgz`;
}

async function download(url, dest) {
	const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(dest, buf);
	return buf.length;
}

function extract(tgz, destDir, cwd) {
	fs.mkdirSync(destDir, { recursive: true });
	// RELATIVE names with cwd: GNU tar (Git Bash) treats "C:\..." as a remote
	// host spec ("Cannot connect to C: resolve failed") — relative avoids that
	execFileSync("tar", ["-xzf", path.basename(tgz), "-C", path.basename(destDir)], {
		cwd,
		stdio: "pipe",
	});
	// npm tarballs unpack to package/
	const pkg = path.join(destDir, "package");
	if (!fs.existsSync(pkg)) throw new Error(`unexpected tarball layout in ${destDir}`);
	return pkg;
}

async function main() {
	if (process.argv.includes("--check")) {
		const js = path.join(OUT_DIR, "wterm.js");
		const css = path.join(OUT_DIR, "terminal.css");
		// esbuild appends legal comments at the END of the bundle — scan it all
		const text = fs.existsSync(js) ? fs.readFileSync(js, "utf8") : "";
		if (text.includes(`@wterm/dom@${WTERM_VERSION}`) && fs.existsSync(css)) {
			console.log(`[vendor-wterm] up to date (@wterm/dom@${WTERM_VERSION})`);
			return;
		}
		console.error("[vendor-wterm] outputs missing or stale — run: node vendor-wterm.mjs");
		process.exit(1);
	}

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wterm-vendor-"));
	try {
		const pkgDirs = {};
		for (const pkg of PKGS) {
			const tgz = path.join(tmp, pkg.name.replace("/", "_") + ".tgz");
			const bytes = await download(npmTarballUrl(pkg.name, pkg.version), tgz);
			pkgDirs[pkg.name] = extract(tgz, path.join(tmp, pkg.name.replace("/", "_")), tmp);
			console.log(`[vendor-wterm] ${pkg.name}@${pkg.version} (${(bytes / 1024).toFixed(0)}KB tgz)`);
		}
		// sanity: dom must not want a different core major than we vendored
		const domPkg = JSON.parse(fs.readFileSync(path.join(pkgDirs["@wterm/dom"], "package.json"), "utf8"));
		const coreWanted = domPkg.dependencies?.["@wterm/core"];
		if (coreWanted && coreWanted !== PKGS[1].version) {
			console.warn(`[vendor-wterm] WARNING: @wterm/dom wants @wterm/core ${coreWanted}, vendoring ${PKGS[1].version}`);
		}

		fs.mkdirSync(OUT_DIR, { recursive: true });
		const cssSrc = path.join(pkgDirs["@wterm/dom"], "src", "terminal.css");
		fs.copyFileSync(cssSrc, path.join(OUT_DIR, "terminal.css"));

		// single-file bundle: bare specifier aliased to the vendored dists
		await esbuild.build({
			stdin: {
				// "//!" = legal comment — esbuild keeps it in the minified bundle so
				// vendor-wterm.mjs --check can verify the vendored version
				contents: `//! vendored from @wterm/dom@${WTERM_VERSION} + @wterm/core@${WTERM_VERSION} (Apache-2.0) — regenerate with: node vendor-wterm.mjs\nexport { WTerm } from "@wterm/dom";\n`,
				resolveDir: HERE,
				loader: "js",
				sourcefile: "vendor-entry.js",
			},
			alias: {
				"@wterm/dom": path.join(pkgDirs["@wterm/dom"], "dist", "index.js"),
				"@wterm/core": path.join(pkgDirs["@wterm/core"], "dist", "index.js"),
			},
			bundle: true,
			format: "esm",
			platform: "browser",
			target: ["es2022"],
			minify: true,
			legalComments: "inline",
			outfile: path.join(OUT_DIR, "wterm.js"),
			logLevel: "warning",
		});
		const kb = (fs.statSync(path.join(OUT_DIR, "wterm.js")).size / 1024).toFixed(0);
		const cssKb = (fs.statSync(path.join(OUT_DIR, "terminal.css")).size / 1024).toFixed(1);
		console.log(`[vendor-wterm] wrote public/vendor/wterm/wterm.js (${kb}KB) + terminal.css (${cssKb}KB)`);
	} finally {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

main().catch((err) => {
	console.error("[vendor-wterm] failed:", err?.message || err);
	process.exit(1);
});
