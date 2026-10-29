// theme.ts — the theme preference, in ONE place.
//
// Contract (unchanged from the mini-lit ThemeToggle this replaces): localStorage key
// `theme` = "system" | "light" | "dark" and a `.dark` class on <html>.
//
// WHY this module (user request 2026-10-28: "Move theme selector in settings"): the
// control lived in the HEADER as a cycle button. Settings is where a preference belongs,
// and both sides (the app shell + the dialog) now read/write the same helpers instead of
// duplicating the key/class logic.
export type ThemeMode = "system" | "light" | "dark";

export const THEMES: ThemeMode[] = ["system", "light", "dark"];

export const themeLabel = (m: ThemeMode): string =>
	m === "system" ? "System — follow the OS" : m === "light" ? "Light" : "Dark";

/** Read the stored preference (never throws — private mode falls back to system). */
export function readTheme(): ThemeMode {
	try {
		const v = localStorage.getItem("theme");
		if (v === "light" || v === "dark" || v === "system") return v;
	} catch {
		/* private mode / quota */
	}
	return "system";
}

/** Apply `.dark` on <html> for the CURRENT preference. Called at boot, on an OS scheme
 *  change while `system` is selected, and after every write. */
export function applyThemeClass(): void {
	const t = readTheme();
	const dark = t === "dark" || (t === "system" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
}

/** Persist + apply + broadcast (the header no longer holds the state; anything that cares
 *  listens for `pi-theme-changed`). */
export function setTheme(mode: ThemeMode): ThemeMode {
	try {
		localStorage.setItem("theme", mode);
	} catch {
		/* quota */
	}
	applyThemeClass();
	window.dispatchEvent(new CustomEvent("pi-theme-changed", { detail: mode }));
	return mode;
}
