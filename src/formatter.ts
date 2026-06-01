// ─── formatter.ts ─────────────────────────────────────────────────────────────
// Takes the ReviewResult from reviewer.ts and posts it back to GitHub as:
//   1. Inline comments — one per finding, attached to the exact line
//   2. A top-level review comment — the summary paragraph
// ─────────────────────────────────────────────────────────────────────────────
import { Octokit } from "@octokit/rest";
import type { ReviewResult, ReviewFinding } from "./types";

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN env var is not set");
    _octokit = new Octokit({ auth: token });
  }
  return _octokit;
}

const SEVERITY_EMOJI: Record<ReviewFinding["severity"], string> = {
  critical: "🔴",
  warning:  "🟡",
  info:     "🔵",
};

const SEVERITY_LABEL: Record<ReviewFinding["severity"], string> = {
  critical: "Critical",
  warning:  "Warning",
  info:     "Info",
};

export async function postReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  review: ReviewResult
): Promise<void> {
  const octokit = getOctokit();
  const comments = review.findings.map((finding) => buildInlineComment(finding, commitSha));
  const reviewBody = buildReviewBody(review);
  const event = "COMMENT";

  console.log(`  📬 Posting review: ${comments.length} inline comment(s) + summary`);

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: commitSha,
    body: reviewBody,
    event,
    comments,
  });
}

function buildInlineComment(
  finding: ReviewFinding,
  _commitSha: string
): {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
} {
  const emoji = SEVERITY_EMOJI[finding.severity];
  const label = SEVERITY_LABEL[finding.severity];

  const body = [
    `${emoji} **${label}** — AI Code Review`,
    ``,
    finding.comment,
    ``,
    `**Suggested fix:**`,
    "```suggestion",
    finding.suggestion,
    "```",
  ].join("\n");

  return {
    path: finding.file,
    line: finding.line,
    side: "RIGHT",
    body,
  };
}

function buildReviewBody(review: ReviewResult): string {
  if (review.findings.length === 0) {
    return [
      "## 🤖 AI Code Review",
      "",
      "✅ **No issues found.** This PR looks clean.",
      "",
      review.summary,
    ].join("\n");
  }

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of review.findings) counts[f.severity]++;

  const tableRows: string[] = [];
  if (counts.critical > 0) tableRows.push(`| 🔴 Critical | ${counts.critical} |`);
  if (counts.warning > 0)  tableRows.push(`| 🟡 Warning  | ${counts.warning} |`);
  if (counts.info > 0)     tableRows.push(`| 🔵 Info     | ${counts.info} |`);

  const table = [
    "| Severity | Count |",
    "|----------|-------|",
    ...tableRows,
  ].join("\n");

  return [
    "## 🤖 AI Code Review",
    "",
    review.summary,
    "",
    "### Findings",
    "",
    table,
    "",
    "_Review each inline comment above for details and one-click fix suggestions._",
  ].join("\n");
}