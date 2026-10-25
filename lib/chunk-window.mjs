// lib/chunk-window.mjs — the CHUNK boundary definition, shared by the server and the client.
//
// WHY SHARED (C4, 2026-10-24): the IDB cache stores one chunk per 64-message window and keys it
// by [sessionId, rewriteSeq, fromSeq]. If the server's /range windows and the client's live
// write-through used different boundaries, the same messages would be stored twice under two
// keys, the coverage would carry a seam, and a fetch could not reuse a live-written chunk. The
// boundary must therefore be ONE pure function of the seq, imported by both sides.
//
// The client re-exports these from src/idb-cache.ts (API unchanged); server.mjs and
// agent-hub.mjs import this file directly.

/** Messages per aligned chunk (~550KB on the measured sessions — under the 1MB /range cap). */
export const CHUNK_INTERVAL = 64;
export const chunkIndexOf = (seq) => Math.floor(Math.max(0, seq) / CHUNK_INTERVAL);
export const chunkFromSeq = (index) => index * CHUNK_INTERVAL;
export const chunkToSeq = (index) => (index + 1) * CHUNK_INTERVAL; // exclusive
export const isChunkAligned = (seq) => seq >= 0 && seq % CHUNK_INTERVAL === 0;

/** Snap a window bound DOWN to the enclosing chunk start (never cuts what was requested). */
export const alignDown = (seq) => chunkFromSeq(chunkIndexOf(seq));
/** Snap a window bound UP to the next chunk end (a stored window then ENDS on a boundary,
 *  so the next window starts exactly where it stopped). */
export const alignUp = (seq) => (isChunkAligned(seq) ? seq : chunkToSeq(chunkIndexOf(seq)));
