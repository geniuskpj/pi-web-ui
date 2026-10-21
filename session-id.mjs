// session-id.mjs — shared between server.mjs (main thread) and session-worker.mjs
// (worker thread). Workers don't share module scope, so a constant used on both
// sides of the seam must live in an imported module, not be duplicated.
// bugs.md #14.
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
