# Commit Review

**Commit:** `aa1f503` — Fix post-restart 400s: persist full messages, re-link orphan toolResults
**Review date:** 2026-10-22

## Findings

### P2 — Mixed linked and orphaned tool results can corrupt restored tool-call history

**File:** [agent-hub.mjs](./agent-hub.mjs#L49)
**Confidence:** High

The repair loop advances `k` only when it assigns an ID to an orphan result. It does not advance past tool calls already represented by linked results in the same consecutive result group. For an assistant message containing calls `a` and `b`, followed by a linked result for `a` and an orphan result for `b`, the orphan is assigned `a` as well. The later `matched` check sees `a` but not `b`, so it removes call `b` from the assistant message while retaining both results with the duplicate ID. This leaves a mismatched transcript and can send duplicate `tool_call_id` values to the provider.

The existing regression test covers all-linked and all-orphan groups, but not a mixed group. A targeted probe reproduced the result IDs `["a", "a"]` and showed that call `b` is removed.

**Recommendation:** When assigning an orphan, skip call IDs already matched by preceding results in this group (or align each result to its call position while validating existing IDs). Add a mixed linked/orphan regression case that asserts both unique result IDs and preservation of both calls.

### P3 — The one-time mirror repair can misreport and miss repairs

**File:** [tests/repair-mirror-toolcalls.mjs](./tests/repair-mirror-toolcalls.mjs#L38)
**Confidence:** High

The script has two reporting/coverage gaps:

- `normalizeRestoredMessages()` drops tool results it cannot link. The script then calculates `stillOrphan` from that filtered array and reports `orphans - stillOrphan` as “re-linked.” An unmatchable result that was discarded is therefore reported as successfully re-linked, with zero unmatchable results. A targeted probe confirmed this outcome.
- The `if (!orphans) continue` fast path skips files that have dangling assistant `toolCall` blocks but no orphan `toolResult`s. Those calls are not removed from the on-disk mirror by the one-time repair, despite the normalizer being intended to clean up dangling calls as well.

**Recommendation:** Track re-linked, discarded, and dangling counts from the original records and normalized output separately. Run normalization whenever either orphan results or dangling calls are present, and make the report distinguish data dropped from data repaired.

## Verification

- `node tests/restore-toolcall.test.mjs` — passed (13 checks).
- Targeted mixed-result probe — reproduced duplicate result IDs and loss of the second tool call.
- Targeted migration-count probe — confirmed a dropped orphan result is counted as re-linked.
