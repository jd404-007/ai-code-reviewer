// ─── github.ts ────────────────────────────────────────────────────────────────
// This file has two responsibilities:
//   1. FETCH  — ask GitHub's API for the raw unified diff of a PR
//   2. PARSE  — turn that raw text into structured objects our reviewer can use
//
// Why keep these together? They're both "GitHub data concerns". The reviewer
// module shouldn't know anything about diffs or Octokit — it just gets clean
// structured data and works with it.
// ─────────────────────────────────────────────────────────────────────────────
import { Octokit } from "@octokit/rest";
import parseDiff from "parse-diff";
import type { ParsedFile, DiffLine } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

// Files we should never send to the AI reviewer:
//   - Lock files (package-lock.json, yarn.lock) are huge and auto-generated
//   - Minified files would waste tokens with unreadable code
//   - Binary/asset files aren't code
const IGNORED_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/,
  /dist\//,
  /build\//,
  /\.next\//,
];

// Cap how many lines per file we send to the AI.
// Claude has a large context window, but sending 2000 added lines from one
// file costs tokens and usually adds noise, not signal.
const MAX_LINES_PER_FILE = 150;

// ─── Octokit singleton ────────────────────────────────────────────────────────

// Same lazy pattern as webhook.ts — create on first use so tests can set env vars.
let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN env var is not set");
    _octokit = new Octokit({ auth: token });
  }
  return _octokit;
}

// ─── Main exported function ───────────────────────────────────────────────────

/**
 * Fetches the diff for a GitHub PR and returns the changed lines per file,
 * ready to be sent to the AI reviewer.
 *
 * @param owner     - GitHub repo owner, e.g. "octocat"
 * @param repo      - GitHub repo name, e.g. "hello-world"
 * @param prNumber  - PR number, e.g. 42
 * @returns         Array of ParsedFile, one entry per changed file (filtered + capped)
 */
export async function fetchAndParseDiff(
  owner: string,
  repo: string,
  prNumber: number
): Promise<ParsedFile[]> {
  // Step 1: Fetch the raw diff text from GitHub
  const rawDiff = await fetchRawDiff(owner, repo, prNumber);

  // Step 2: Parse the diff text into structured objects
  const parsedFiles = parseDiffText(rawDiff);

  // Step 3: Filter out files we don't want to review
  const reviewableFiles = parsedFiles.filter(
    (f) => !shouldIgnoreFile(f.filename)
  );

  console.log(
    `  📂 ${parsedFiles.length} file(s) changed, ` +
    `${reviewableFiles.length} after filtering lock/binary files`
  );

  return reviewableFiles;
}

// ─── Step 1: Fetch raw diff ───────────────────────────────────────────────────

/**
 * Calls GitHub's API with Accept: application/vnd.github.diff
 * which tells GitHub to return the diff as plain text, not JSON.
 *
 * Without the mediaType override, Octokit returns a JSON object describing
 * the PR. With it, we get the raw unified diff — which is what parse-diff needs.
 */
async function fetchRawDiff(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const octokit = getOctokit();

  // The `mediaType` option overrides the Accept header on this one request.
  // "diff" format returns the raw unified diff as a string.
  // "json" format (the default) would return a big JSON object — not useful here.
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  // When using a custom mediaType, the response body is in `response.data`
  // but TypeScript thinks it's a complex object. We cast to string because
  // we know the API returns plain text when format is "diff".
  return response.data as unknown as string;
}

// ─── Step 2: Parse diff text ──────────────────────────────────────────────────

/**
 * Turns raw unified diff text into our own ParsedFile[] structure.
 *
 * What unified diff looks like (simplified):
 *
 * diff --git a/src/auth.ts b/src/auth.ts
 * @@ -8,3 +8,5 @@          ← "hunk header": old start,count → new start,count
 * export function login() {   ← " " prefix = unchanged (context) line
 * -  const q = "SELECT " + id  ← "-" prefix = deleted line (old file)
 * +  const q = db.query(sql,[id]) ← "+" prefix = added line (new file)
 * +  const tok = eval(input)   ← another added line
 * }
 *
 * parse-diff reads this and returns one object per file, each containing
 * "chunks" (hunks), each containing "changes" (individual lines).
 *
 * We only care about `type: "add"` changes — those are lines that exist in
 * the new version of the file and can receive GitHub inline comments.
 */
export function parseDiffText(rawDiff: string): ParsedFile[] {
  // parse-diff returns an array of file objects
  const diffFiles = parseDiff(rawDiff);
  const result: ParsedFile[] = [];

  for (const file of diffFiles) {
    // `file.to` is the filename in the new version.
    // It can be null if the file was deleted entirely — skip those.
    if (!file.to || file.to === "/dev/null") continue;

    const addedLines: DiffLine[] = [];

    // A file's diff is split into "chunks" (also called hunks).
    // Each chunk is a contiguous block of changes.
    // Example: if you edit lines 5-10 and lines 50-55, you get two chunks.
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        // change.type is "add" | "del" | "normal"
        // We only want added lines ("+" lines in the diff).
        //
        // Why skip "del" lines?
        //   - Deleted lines don't exist in the new file
        //   - GitHub's review comment API requires a line number in the new file
        //   - You can't post an inline comment on a line that was deleted
        //
        // Why skip "normal" lines?
        //   - They're context lines (unchanged code shown around the edit)
        //   - They might be interesting for context but we let the AI figure
        //     that out from the surrounding added lines
        if (change.type === "add") {
          addedLines.push({
            // `change.ln` is the line number in the NEW version of the file
            lineNumber: change.ln,
            // Strip the leading "+" from the content so we send clean code
            content: change.content.slice(1),
          });
        }
      }
    }

    // Only include files that actually have added lines
    if (addedLines.length === 0) continue;

    // Cap at MAX_LINES_PER_FILE to keep AI context manageable
    const cappedLines = addedLines.slice(0, MAX_LINES_PER_FILE);
    if (addedLines.length > MAX_LINES_PER_FILE) {
      console.log(
        `  ⚠️  ${file.to}: ${addedLines.length} added lines, ` +
        `capped to first ${MAX_LINES_PER_FILE}`
      );
    }

    result.push({
      filename: file.to,
      addedLines: cappedLines,
    });
  }

  return result;
}

// ─── Step 3: File filter ──────────────────────────────────────────────────────

/**
 * Returns true if we should SKIP this file (i.e. not send it to the AI).
 * Tests against the IGNORED_FILE_PATTERNS list above.
 */
export function shouldIgnoreFile(filename: string): boolean {
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(filename));
}