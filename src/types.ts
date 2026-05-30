// ─── types.ts ────────────────────────────────────────────────────────────────
// This file defines the "shape" of data flowing through the whole project.
// TypeScript uses these to catch mistakes at write-time, not at runtime.
// Think of each interface like a contract: "this object MUST have these fields."
// ─────────────────────────────────────────────────────────────────────────────

// The minimal slice of a GitHub webhook payload that we actually use.
// GitHub sends a giant JSON object — we only care about these fields.
export interface PullRequestPayload {
    action: string;           // e.g. "opened", "synchronize", "closed"
    number: number;           // the PR number, e.g. 42
    repository: {
      owner: { login: string };  // e.g. "octocat"
      name: string;              // e.g. "hello-world"
    };
    pull_request: {
      head: { sha: string };     // the commit SHA at the tip of the PR branch
    };
  }
  
  // One "finding" returned by the AI for a specific line in the diff.
  // The AI will return an array of these.
  export interface ReviewFinding {
    file: string;       // e.g. "src/auth.ts"
    line: number;       // the line number in the NEW version of the file
    severity: "critical" | "warning" | "info";
    comment: string;    // the human-readable explanation
    suggestion: string; // the fixed code (used in GitHub suggestion blocks)
  }
  
  // What our reviewer module returns after analysing a full PR diff.
  export interface ReviewResult {
    findings: ReviewFinding[];
    summary: string;  // a one-paragraph overall summary posted as a top-level PR comment
  }
  
  // A single changed line inside one file's diff chunk.
  // parse-diff gives us these, and we reshape them into this simpler structure.
  export interface DiffLine {
    lineNumber: number;   // line number in the new file
    content: string;      // the actual code, e.g. "  const x = eval(input)"
  }
  
  // One file's worth of added lines extracted from the diff.
  export interface ParsedFile {
    filename: string;       // e.g. "src/auth.ts"
    addedLines: DiffLine[]; // only the lines marked "+" — we skip deletions
  }