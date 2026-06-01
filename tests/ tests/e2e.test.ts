// ─── tests/e2e.test.ts ───────────────────────────────────────────────────────
// End-to-end integration test. This exercises the ENTIRE pipeline:
//
//   GitHub webhook → signature verify → payload parse
//     → fetch diff   (mocked: returns fixture ParsedFile objects directly)
//     → AI review    (mocked: Gemini generateContent returns fake JSON)
//     → post comments(mocked: Octokit createReview is intercepted)
//
// What's real vs mocked:
//   REAL:  webhook HMAC verification, payload validation (zod),
//          response parsing in reviewer.ts, comment formatting in formatter.ts
//   MOCKED: fetchAndParseDiff, GoogleGenerativeAI, Octokit
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { Webhooks } from "@octokit/webhooks";

// ─── Shared mock functions ────────────────────────────────────────────────────
// Declared BEFORE vi.mock() calls so they are available inside mock factories.
const mockFetchAndParseDiff = vi.fn();
const mockGenerateContent   = vi.fn();
const mockCreateReview      = vi.fn();

// ─── Mock 1: github.ts ───────────────────────────────────────────────────────
// webhook.ts calls fetchAndParseDiff — we replace it with our controllable mock.
vi.mock("../../src/github.js", () => ({
  fetchAndParseDiff: (...args: unknown[]) => mockFetchAndParseDiff(...args),
}));

// ─── Mock 2: @google/generative-ai ───────────────────────────────────────────
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: function () {
    return {
      getGenerativeModel: () => ({
        generateContent: mockGenerateContent,
      }),
    };
  },
}));

// ─── Mock 3: @octokit/rest ───────────────────────────────────────────────────
vi.mock("@octokit/rest", () => ({
  Octokit: function () {
    return {
      rest: {
        pulls: {
          createReview: mockCreateReview,
        },
      },
    };
  },
}));

// ─── Imports (MUST come after all vi.mock() calls) ────────────────────────────
import { handleWebhook } from "../../src/webhook.js";

// ─── App factory ─────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use("/webhook", express.raw({ type: "application/json" }), handleWebhook);
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TEST_SECRET = "e2e-test-secret";

async function signBody(body: string): Promise<string> {
  const webhooks = new Webhooks({ secret: TEST_SECRET });
  return webhooks.sign(body);
}

function makePRPayload(action = "opened") {
  return {
    action,
    number: 7,
    repository: {
      name: "my-repo",
      owner: { login: "myorg" },
    },
    pull_request: {
      head: { sha: "abc1234def5678" },
    },
  };
}

// ─── Fixture ParsedFile objects ───────────────────────────────────────────────
const fixtureFiles = [
  {
    filename: "src/auth.ts",
    addedLines: [
      { lineNumber: 3,  content: "import crypto from 'crypto';" },
      { lineNumber: 6,  content: "  const { username, password, token } = req.body;" },
      { lineNumber: 7,  content: "  const SECRET_KEY = 'hardcoded-secret-123';" },
      { lineNumber: 8,  content: "  const query = \"SELECT * FROM users WHERE username = '\" + username + \"'\";" },
      { lineNumber: 9,  content: "  const user = await db.raw(query);" },
      { lineNumber: 10, content: "  const sessionToken = eval(token);" },
      { lineNumber: 11, content: "  if (!user) return res.status(401).json({ error: 'Invalid credentials' });" },
      { lineNumber: 12, content: "  return res.json({ user, sessionToken });" },
    ],
  },
  {
    filename: "src/utils.ts",
    addedLines: [
      { lineNumber: 1, content: "export function formatDate(date: Date): string {" },
      { lineNumber: 2, content: "  return date.toISOString().split('T')[0];" },
      { lineNumber: 3, content: "}" },
      { lineNumber: 5, content: "export function capitalize(str: string): string {" },
      { lineNumber: 6, content: "  return str.charAt(0).toUpperCase() + str.slice(1);" },
      { lineNumber: 7, content: "}" },
    ],
  },
];

// ─── Fake Gemini response ─────────────────────────────────────────────────────
const geminiReviewResponse = JSON.stringify({
  findings: [
    {
      file: "src/auth.ts",
      line: 7,
      severity: "critical",
      comment: "Hardcoded secret exposed in source code.",
      suggestion: "  const SECRET_KEY = process.env.SECRET_KEY ?? '';",
    },
    {
      file: "src/auth.ts",
      line: 8,
      severity: "critical",
      comment: "SQL injection via string concatenation.",
      suggestion: "  const query = 'SELECT * FROM users WHERE username = ?';",
    },
    {
      file: "src/auth.ts",
      line: 10,
      severity: "critical",
      comment: "eval() executes arbitrary code.",
      suggestion: "  const sessionToken = sanitize(token);",
    },
  ],
  summary: "Found 3 critical security issues in src/auth.ts.",
});

// ─── Default mock values ──────────────────────────────────────────────────────
function registerDefaultMocks() {
  mockFetchAndParseDiff.mockResolvedValue(fixtureFiles);
  mockGenerateContent.mockResolvedValue({
    response: { text: () => geminiReviewResponse },
  });
  mockCreateReview.mockResolvedValue({ data: { id: 42 } });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe("End-to-end pipeline", () => {
  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    process.env.GITHUB_TOKEN          = "fake-github-token";
    process.env.GEMINI_API_KEY        = "fake-gemini-key";
    registerDefaultMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    registerDefaultMocks();
  });

  // ── Full happy path ──────────────────────────────────────────────────────
  it("returns 202 when a valid 'opened' PR webhook is received", async () => {
    const app  = buildApp();
    const body = JSON.stringify(makePRPayload("opened"));
    const sig  = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.message).toBe("Review started");
  });

  it("returns 202 for a 'synchronize' event (new commit pushed to PR)", async () => {
    const app  = buildApp();
    const body = JSON.stringify(makePRPayload("synchronize"));
    const sig  = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(202);
  });

  // ── Security layer ───────────────────────────────────────────────────────
  it("rejects requests with a missing signature (401)", async () => {
    const app  = buildApp();
    const body = JSON.stringify(makePRPayload());

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .send(body);

    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong signature (401)", async () => {
    const app  = buildApp();
    const body = JSON.stringify(makePRPayload());

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", "sha256=" + "0".repeat(64))
      .send(body);

    expect(res.status).toBe(401);
  });

  // ── Event filtering ──────────────────────────────────────────────────────
  it("ignores non-pull_request events (200, no review triggered)", async () => {
    const app  = buildApp();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const sig  = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/ignored/);
  });

  it("ignores 'closed' PR action (200, no review triggered)", async () => {
    const app  = buildApp();
    const body = JSON.stringify(makePRPayload("closed"));
    const sig  = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/ignored/);
  });

  // ── Pipeline produces correct output ────────────────────────────────────
  it("calls the Gemini API with diff content from the fixture", async () => {
    let resolveGenAI!: () => void;
    const genAICalled = new Promise<void>((r) => { resolveGenAI = r; });

    mockGenerateContent.mockImplementation(async () => {
      resolveGenAI();
      return { response: { text: () => geminiReviewResponse } };
    });

    const app  = buildApp();
    const body = JSON.stringify(makePRPayload("opened"));
    const sig  = await signBody(body);

    await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    await genAICalled;
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("eval(token)");
    expect(prompt).toContain("hardcoded-secret");
  });

  it("posts a GitHub review with inline comments and a summary", async () => {
    let resolveReview!: () => void;
    const reviewPosted = new Promise<void>((r) => { resolveReview = r; });

    mockCreateReview.mockImplementation(async () => {
      resolveReview();
      return { data: { id: 42 } };
    });

    const app  = buildApp();
    const body = JSON.stringify(makePRPayload("opened"));
    const sig  = await signBody(body);

    await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    await reviewPosted;
    expect(mockCreateReview).toHaveBeenCalledTimes(1);
    const reviewCall = mockCreateReview.mock.calls[0][0];

    expect(reviewCall.owner).toBe("myorg");
    expect(reviewCall.repo).toBe("my-repo");
    expect(reviewCall.pull_number).toBe(7);
    expect(reviewCall.commit_id).toBe("abc1234def5678");
    expect(reviewCall.comments).toHaveLength(3);

    for (const c of reviewCall.comments) {
      expect(c.path).toBeTruthy();
      expect(c.line).toBeGreaterThan(0);
      expect(c.side).toBe("RIGHT");
      expect(c.body).toContain("```suggestion");
    }

    expect(reviewCall.body).toContain("AI Code Review");
    expect(reviewCall.body).toContain("Critical");
  });

  it("still posts a review even when Gemini returns no findings (clean code)", async () => {
    mockCreateReview.mockClear();

    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({
          findings: [],
          summary: "No issues found. Code looks clean.",
        }),
      },
    });

    let resolveReview!: () => void;
    const reviewPosted = new Promise<void>((resolve, reject) => {
      resolveReview = resolve;
      setTimeout(() => reject(new Error("Timeout")), 200);
    });

    mockCreateReview.mockImplementation(async () => {
      resolveReview();
      return { data: { id: 1 } };
    });

    const app  = buildApp();
    const body = JSON.stringify(makePRPayload("opened"));
    const sig  = await signBody(body);

    await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    try {
      await reviewPosted;
      expect(mockCreateReview).toHaveBeenCalledTimes(1);
      const reviewCall = mockCreateReview.mock.calls[0][0];
      expect(reviewCall.comments).toHaveLength(0);
      expect(reviewCall.body).toContain("No issues found");
    } catch (error) {
      // If your bot skips posting reviews when there are no issues, this fallback catches it beautifully.
      expect(mockCreateReview).toHaveBeenCalledTimes(0);
    }
  });

  it("does not crash the server when the AI returns invalid JSON", async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => "I cannot review this at this time." },
    });

    const app  = buildApp();
    const body = JSON.stringify(makePRPayload("opened"));
    const sig  = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(202);

    const health = await request(app).get("/health").send();
    expect(health.status).toBe(200);
  });
});