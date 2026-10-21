#!/usr/bin/env node
/**
 * build.mjs — esbuild bundler (NO Vite). P4: pi-web-ui is GONE — no dist
 * patching, no stub aliases, no pdf worker, no katex fonts.
 *
 * - app.css (theme variables + tailwind utilities): vendored static copy in
 *   public/assets/app.css — refreshed from pi-web-ui while it is still
 *   installed; kept as-is after removal (it is a build OUTPUT, not a dep).
 * - highlight.js is aliased to lib/common (~40 langs, ~40KB gz).
 *
 * Usage: node build.mjs [--watch] [--debug]
 *   (default: minified; --debug keeps readable output + sourcemaps)
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const hljsCommonPlugin = {
	name: "hljs-common",
	setup(build) {
		build.onResolve({ filter: /^highlight\.js$/ }, () => ({
			path: path.join(HERE, "node_modules", "highlight.js", "lib", "common.js"),
		}));
	},
};

// vendored stylesheet (theme variables + tailwind utilities + .dark theme):
// refresh from pi-web-ui while it is still installed; after removal the
// existing public/assets/app.css stays (it is build OUTPUT, not a dep)
fs.mkdirSync(path.join(HERE, "public", "assets"), { recursive: true });
const vendoredCss = path.join(HERE, "public", "assets", "app.css");
const webUiCss = path.join(HERE, "node_modules", "@earendil-works", "pi-web-ui", "dist", "app.css");
if (fs.existsSync(webUiCss)) {
	fs.copyFileSync(webUiCss, vendoredCss); // verbatim: url(fonts/…) + tailwind layers
} else if (!fs.existsSync(vendoredCss)) {
	throw new Error("public/assets/app.css missing and pi-web-ui not installed — restore the vendored copy first.");
}

// terminal renderer is vendored (prebuilt wterm dist) — fail early with a
// clear message instead of shipping a UI whose terminal 404s at runtime
try {
	execFileSync(process.execPath, [path.join(HERE, "vendor-wterm.mjs"), "--check"], { stdio: "inherit" });
} catch {
	process.exit(1); // vendor-wterm.mjs already printed the reason
}

// precompress large text assets (server serves .br/.gz when the client accepts).
// CRITICAL: this must run AFTER esbuild writes the bundle — running it in a
// floating promise before the build finishes compresses the PREVIOUS output and
// leaves .br/.gz stale. Browsers send `Accept-Encoding: br`, so they'd load the
// old bundle while curl (no br) loads the new one — the classic "model not
// loaded" / stale-UI bug.
function computeManifest(metafile) {
	const jsOut = Object.keys(metafile.outputs).find((f) => /assets[\\/]app-[^/\\]+\.js$/.test(f));
	const cssOut = Object.keys(metafile.outputs).find((f) => /assets[\\/]app-[^/\\]+\.css$/.test(f));
	return {
		app: jsOut ? path.basename(jsOut) : "app.js",
		css: cssOut ? path.basename(cssOut) : "app.css",
	};
}

function compressAssets(manifest) {
	for (const rel of ["assets/" + manifest.app, "assets/" + manifest.css, "style.css"]) {
		const file = path.join(HERE, "public", rel);
		if (!fs.existsSync(file)) continue;
		const data = fs.readFileSync(file);
		fs.writeFileSync(file + ".gz", gzipSync(data, { level: 9 }));
		fs.writeFileSync(file + ".br", brotliCompressSync(data));
	}
	const mb = (f) => (fs.statSync(path.join(HERE, "public", f)).size / 1048576).toFixed(2) + "MB";
	// prune stale hashed bundles (keep only the manifest's current set)
	try {
		const keep = new Set([manifest.app, manifest.css, manifest.app + ".br", manifest.app + ".gz", manifest.css + ".br", manifest.css + ".gz", "manifest.json"]);
		for (const f of fs.readdirSync(path.join(HERE, "public", "assets"))) {
			if (/^app-.*(\\.br|\\.gz)?$/.test(f) && !keep.has(f)) fs.unlinkSync(path.join(HERE, "public", "assets", f));
		}
	} catch {
		/* noop */
	}
	console.log(
		`[build] ${manifest.app} ${mb("assets/" + manifest.app)} (br: ${(fs.statSync(path.join(HERE, "public", "assets", manifest.app + ".br")).size / 1048576).toFixed(2)}MB)`,
	);
}

// write manifest + compress after every successful build (covers --watch too)
const compressPlugin = {
	name: "compress-assets",
	setup(build) {
		build.onEnd((result) => {
			if (result.errors.length || !result.metafile) return;
			const manifest = computeManifest(result.metafile);
			fs.writeFileSync(path.join(HERE, "public", "assets", "manifest.json"), JSON.stringify(manifest));
			compressAssets(manifest);
		});
	},
};

const debug = process.argv.includes("--debug");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
	entryPoints: [path.join(HERE, "src", "main.tsx")],
	// content-hashed filename: a rebuilt bundle is a NEW URL — browsers can
	// never serve a stale app.js (the root cause of "model not loaded" ghosts)
	entryNames: "app-[hash]",
	bundle: true,
	outdir: path.join(HERE, "public", "assets"),
	outExtension: { ".js": ".js", ".css": ".css" },
	format: "esm",
	target: ["es2022"],
	platform: "browser",
	jsx: "automatic",
	jsxImportSource: "preact",
	// minify by default (8.7MB -> ~2.5MB); --debug keeps it readable + sourcemaps
	minify: !debug,
	sourcemap: debug,
	define: { __DEBUG__: debug ? "true" : "false" },
	plugins: [hljsCommonPlugin, compressPlugin],
	metafile: true,
	logLevel: "info",
	loader: { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".css": "css" },
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log("[build] watching for changes...");
} else {
	const result = await esbuild.build(options);
	compressAssets(computeManifest(result.metafile));
	console.log('[build] done -> public/assets/');
}
