// ─── tests/formatter.test.ts ─────────────────────────────────────────────────
// Tests for the GitHub comment formatter.
//
// We mock Octokit to intercept the API call and verify formatting logic.
// ─────────────────────────────────────────────────────────────────────────────

declare const process: any; // Prevents the 'process' redline error completely

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewResult } from "../src/types";
import { postReviewComments } from "../src/formatter";

// Create a mock tracking function for the GitHub API call
const mockCreateReview = vi.fn().mockResolvedValue({ data: { id: 1 } });

// Mock the Octokit REST library cleanly using standard Vitest strategies
// Replace the old vi.mock("@octokit/rest") block with this one:
vi.mock("@octokit/rest", () => {
    return {
      Octokit: class {
        rest = {
          pulls: {
            createReview: mockCreateReview,
          },
        };
      },
    };
  });

// ─── Sample data ──────────────────────────────────────────────────────────────

const sampleReview: ReviewResult = {
  findings: [
    {
      file: "src/auth.ts",
      line: 4,
      severity: "critical",
      comment: "Hardcoded secret detected. This will be visible in version control.",
      suggestion: "  const SECRET_KEY = process.env.SECRET_KEY ?? '';",
    },
    {
      file: "src/auth.ts",
      line: 5,
      severity: "warning",
      comment: "SQL injection vulnerability via string concatenation.",
      suggestion: '  const query = "SELECT * FROM users WHERE username = ?";',
    },
    {
      file: "src/utils.ts",
      line: 2,
      severity: "info",
      comment: "Consider adding a null check for robustness.",
      suggestion: "  if (!date) return '';",
    },
  ],
  summary: "Found 3 issues: 1 critical, 1 warning, 1 info. Please review inline comments.",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("postReviewComments — API call", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "fake-token";
    vi.clearAllMocks();
  });

  it("calls createReview exactly once", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);
    expect(mockCreateReview).toHaveBeenCalledTimes(1);
  });

  it("passes correct owner, repo, and PR number", async () => {
    await postReviewComments("myorg", "my-repo", 99, "deadbeef", sampleReview);

    const call = mockCreateReview.mock.calls[0][0];
    expect(call.owner).toBe("myorg");
    expect(call.repo).toBe("my-repo");
    expect(call.pull_number).toBe(99);
  });

  it("passes the commit SHA", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234xyz", sampleReview);

    const call = mockCreateReview.mock.calls[0][0];
    expect(call.commit_id).toBe("abc1234xyz");
  });

  it("uses COMMENT event (never blocks merge automatically)", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const call = mockCreateReview.mock.calls[0][0];
    expect(call.event).toBe("COMMENT");
  });

  it("creates one comment per finding", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const call = mockCreateReview.mock.calls[0][0];
    expect(call.comments).toHaveLength(3);
  });

  it("passes zero comments when there are no findings", async () => {
    const emptyReview: ReviewResult = { findings: [], summary: "All clear." };
    await postReviewComments("octocat", "hello-world", 42, "abc1234", emptyReview);

    const call = mockCreateReview.mock.calls[0][0];
    expect(call.comments).toHaveLength(0);
  });
});

describe("postReviewComments — inline comment format", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "fake-token";
    vi.clearAllMocks();
  });

  it("sets the correct file path on each comment", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    expect(comments[0].path).toBe("src/auth.ts");
    expect(comments[1].path).toBe("src/auth.ts");
    expect(comments[2].path).toBe("src/utils.ts");
  });

  it("sets the correct line number on each comment", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    expect(comments[0].line).toBe(4);
    expect(comments[1].line).toBe(5);
    expect(comments[2].line).toBe(2);
  });

  it("sets side to RIGHT (new version of the file)", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    for (const c of comments) {
      expect(c.side).toBe("RIGHT");
    }
  });

  it("includes the severity emoji in the comment body", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    expect(comments[0].body).toContain("🔴");
    expect(comments[1].body).toContain("🟡");
    expect(comments[2].body).toContain("🔵");
  });

  it("includes the severity label in the comment body", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    expect(comments[0].body).toContain("Critical");
    expect(comments[1].body).toContain("Warning");
    expect(comments[2].body).toContain("Info");
  });

  it("includes the human-readable comment text", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    expect(comments[0].body).toContain("Hardcoded secret detected");
    expect(comments[1].body).toContain("SQL injection");
  });

  it("includes a suggestion block for one-click apply", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    for (const c of comments) {
      expect(c.body).toContain("```suggestion");
    }
  });

  it("puts the suggested code inside the suggestion block", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const comments = mockCreateReview.mock.calls[0][0].comments;
    expect(comments[0].body).toContain("process.env.SECRET_KEY");
    expect(comments[1].body).toContain("WHERE username = ?");
  });
});

describe("postReviewComments — review body (summary)", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "fake-token";
    vi.clearAllMocks();
  });

  it("includes the AI Code Review heading", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain("AI Code Review");
  });

  it("includes the summary text from the reviewer", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain("1 critical, 1 warning, 1 info");
  });

  it("includes a findings count table", async () => {
    await postReviewComments("octocat", "hello-world", 42, "abc1234", sampleReview);

    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain("| Severity | Count |");
    expect(body).toContain("🔴 Critical");
    expect(body).toContain("🟡 Warning");
    expect(body).toContain("🔵 Info");
  });

  it("shows a clean all-clear message when there are no findings", async () => {
    const clean: ReviewResult = { findings: [], summary: "No issues found." };
    await postReviewComments("octocat", "hello-world", 42, "abc1234", clean);

    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain("✅");
    expect(body).toContain("No issues found");
    expect(body).not.toContain("| Severity | Count |");
  });

  it("omits table rows for severity levels with zero findings", async () => {
    const criticalOnly: ReviewResult = {
      findings: [
        {
          file: "src/auth.ts",
          line: 4,
          severity: "critical",
          comment: "Bad",
          suggestion: "Fix",
        },
      ],
      summary: "One critical issue.",
    };
    await postReviewComments("octocat", "hello-world", 42, "abc1234", criticalOnly);

    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain("🔴 Critical");
    expect(body).not.toContain("🟡 Warning");
    expect(body).not.toContain("🔵 Info");
  });
});