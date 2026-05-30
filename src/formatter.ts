// ─── formatter.ts (STUB) ─────────────────────────────────────────────────────
// We'll fill this out in Phase 4.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReviewResult } from "./types";

export async function postReviewComments(
  _owner: string,
  _repo: string,
  _prNumber: number,
  _commitSha: string,
  _review: ReviewResult
): Promise<void> {
  throw new Error("Not implemented yet — coming in Phase 4");
}