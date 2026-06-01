// ─── tests/reviewer.test.ts ──────────────────────────────────────────────────
// Tests for the AI reviewer module adjusted for Gemini.
// ─────────────────────────────────────────────────────────────────────────────

declare const process: any; // Prevents the 'process' redline error completely

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParsedFile } from "../src/types.js";
import { reviewDiff } from "../src/reviewer.js";

// Create a mock tracking function we can intercept inside tests
const mockGenerateContent = vi.fn();

// Mock the entire Google Generative AI module using an ES6 class structure
vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContent: mockGenerateContent,
        };
      }
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Wraps a raw string payload into the exact structure Gemini returns, safely trimming it
function makeGeminiResponse(text: string) {
  return {
    response: {
      text: () => text.trim(),
    },
  };
}

const sampleFiles: ParsedFile[] = [
  {
    filename: "src/auth.ts",
    addedLines: [
      { lineNumber: 4, content: "  const SECRET_KEY = 'hardcoded-secret-123';" },
      { lineNumber: 5, content: "  const query = \"SELECT * FROM users WHERE username = '\" + username + \"'\";" },
      { lineNumber: 6, content: "  const sessionToken = eval(token);" },
      { lineNumber: 7, content: "  return res.json({ user, sessionToken });" },
    ],
  },
  {
    filename: "src/utils.ts",
    addedLines: [
      { lineNumber: 1, content: "export function formatDate(date: Date): string {" },
      { lineNumber: 2, content: "  return date.toISOString().split('T')[0];" },
      { lineNumber: 3, content: "}" },
    ],
  },
];

const goodGeminiResponse = JSON.stringify({
  findings: [
    {
      file: "src/auth.ts",
      line: 4,
      severity: "critical",
      comment: "Hardcoded secret detected. This will be visible to anyone with repository access.",
      suggestion: "  const SECRET_KEY = process.env.SECRET_KEY ?? '';",
    },
    {
      file: "src/auth.ts",
      line: 5,
      severity: "critical",
      comment: "SQL injection vulnerability. String concatenation with user input allows query manipulation.",
      suggestion: "  const query = \"SELECT * FROM users WHERE username = ?\";",
    },
    {
      file: "src/auth.ts",
      line: 6,
      severity: "critical",
      comment: "eval() executes arbitrary code and is a serious security risk.",
      suggestion: "  const sessionToken = sanitizeToken(token);",
    },
  ],
  summary: "Found 3 critical security issues in src/auth.ts: a hardcoded secret, SQL injection, and use of eval(). These must be fixed before merging.",
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reviewDiff — happy path", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "fake-key-for-tests";
    vi.clearAllMocks();
  });

  it("returns all findings from a well-formed Gemini response", async () => {
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(goodGeminiResponse));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(3);
  });

  it("maps finding fields correctly", async () => {
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(goodGeminiResponse));

    const result = await reviewDiff(sampleFiles);
    const first = result.findings[0];

    expect(first.file).toBe("src/auth.ts");
    expect(first.line).toBe(4);
    expect(first.severity).toBe("critical");
    expect(first.comment).toContain("Hardcoded secret");
    expect(first.suggestion).toContain("process.env.SECRET_KEY");
  });

  it("returns the summary from Gemini", async () => {
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(goodGeminiResponse));

    const result = await reviewDiff(sampleFiles);

    expect(result.summary).toContain("3 critical security issues");
  });

  it("returns empty findings for a clean-code response", async () => {
    const cleanResponse = JSON.stringify({
      findings: [],
      summary: "No issues found. Code looks clean.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(cleanResponse));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("clean");
  });
});

describe("reviewDiff — defensive parsing", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "fake-key-for-tests";
    vi.clearAllMocks();
  });

  it("strips markdown code fences if Gemini wraps JSON in them", async () => {
    const fencedResponse = "```json\n" + goodGeminiResponse + "\n```";
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(fencedResponse));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(3);
  });

  it("also handles plain ``` fences without the json label", async () => {
    const fencedResponse = "```\n" + goodGeminiResponse + "\n```";
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(fencedResponse));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(3);
  });

  it("normalises severity from unexpected casing (e.g. 'Critical' → 'critical')", async () => {
    const weirdCaseResponse = JSON.stringify({
      findings: [
        {
          file: "src/auth.ts",
          line: 4,
          severity: "Critical",
          comment: "Test comment",
          suggestion: "fix",
        },
      ],
      summary: "One issue.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(weirdCaseResponse));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings[0].severity).toBe("critical");
  });

  it("defaults severity to 'warning' for unknown severity values", async () => {
    const unknownSeverity = JSON.stringify({
      findings: [
        {
          file: "src/auth.ts",
          line: 4,
          severity: "high",
          comment: "Test",
          suggestion: "fix",
        },
      ],
      summary: "One issue.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(unknownSeverity));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings[0].severity).toBe("warning");
  });

  it("normalises line numbers given as strings instead of integers", async () => {
    const stringLineResponse = JSON.stringify({
      findings: [
        {
          file: "src/auth.ts",
          line: "4",
          severity: "critical",
          comment: "Test",
          suggestion: "fix",
        },
      ],
      summary: "One issue.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(stringLineResponse));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings[0].line).toBe(4);
    expect(typeof result.findings[0].line).toBe("number");
  });

  it("discards findings for files not in the input", async () => {
    const hallucFile = JSON.stringify({
      findings: [
        {
          file: "src/nonexistent.ts",
          line: 1,
          severity: "warning",
          comment: "Test",
          suggestion: "fix",
        },
      ],
      summary: "One issue.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(hallucFile));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(0);
  });

  it("snaps hallucinated line numbers to the closest valid line", async () => {
    const hallucLine = JSON.stringify({
      findings: [
        {
          file: "src/auth.ts",
          line: 99,
          severity: "warning",
          comment: "Test",
          suggestion: "fix",
        },
      ],
      summary: "One issue.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(hallucLine));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].line).toBe(7);
  });

  it("discards findings with invalid (non-numeric) line numbers", async () => {
    const badLine = JSON.stringify({
      findings: [
        {
          file: "src/auth.ts",
          line: "not-a-number",
          severity: "warning",
          comment: "Test",
          suggestion: "fix",
        },
      ],
      summary: "One issue.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(badLine));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(0);
  });

  it("discards malformed findings that are missing required fields", async () => {
    const missingFields = JSON.stringify({
      findings: [
        { file: "src/auth.ts", line: 4 },
        { line: 5, severity: "warning", comment: "Test", suggestion: "fix" },
      ],
      summary: "Two issues.",
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(missingFields));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(0);
  });

  it("returns a safe fallback when Gemini returns completely invalid JSON", async () => {
    mockGenerateContent.mockResolvedValue(
      makeGeminiResponse("Sorry I cannot review this code at this time.")
    );

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("could not be parsed");
  });

  it("returns a safe fallback when Gemini returns empty string", async () => {
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(""));

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(0);
  });

  it("returns a safe fallback when Gemini returns an object without findings array", async () => {
    mockGenerateContent.mockResolvedValue(
      makeGeminiResponse(JSON.stringify({ error: "something went wrong" }))
    );

    const result = await reviewDiff(sampleFiles);

    expect(result.findings).toHaveLength(0);
  });

  it("generates a fallback summary when Gemini omits it", async () => {
    const noSummary = JSON.stringify({
      findings: [
        {
          file: "src/auth.ts",
          line: 4,
          severity: "critical",
          comment: "Hardcoded secret",
          suggestion: "use env var",
        },
      ],
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(noSummary));

    const result = await reviewDiff(sampleFiles);

    expect(result.summary).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

describe("reviewDiff — fallback summary generation", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "fake-key-for-tests";
    vi.clearAllMocks();
  });

  it("mentions critical count in fallback summary", async () => {
    const twoIssues = JSON.stringify({
      findings: [
        { file: "src/auth.ts", line: 4, severity: "critical", comment: "A", suggestion: "B" },
        { file: "src/auth.ts", line: 6, severity: "warning",  comment: "C", suggestion: "D" },
      ],
    });
    mockGenerateContent.mockResolvedValue(makeGeminiResponse(twoIssues));

    const result = await reviewDiff(sampleFiles);

    expect(result.summary).toMatch(/critical/i);
    expect(result.summary).toMatch(/warning/i);
  });

  it("returns clean message when findings array is empty", async () => {
    mockGenerateContent.mockResolvedValue(
      makeGeminiResponse(JSON.stringify({ findings: [] }))
    );

    const result = await reviewDiff(sampleFiles);

    expect(result.summary).toMatch(/no issues|clean/i);
  });
});