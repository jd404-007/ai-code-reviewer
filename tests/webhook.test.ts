// ─── tests/webhook.test.ts ───────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest"; 
import { Webhooks } from "@octokit/webhooks";

// ── Mock the three pipeline modules ─────────────────────────────────────────
vi.mock("../src/github", () => ({
  fetchAndParseDiff: vi.fn().mockResolvedValue([
    {
      filename: "src/auth.ts",
      addedLines: [{ lineNumber: 10, content: "  const x = eval(input)" }],
    },
  ]),
}));

vi.mock("../src/reviewer", () => ({
  reviewDiff: vi.fn().mockResolvedValue({
    findings: [
      {
        file: "src/auth.ts",
        line: 10,
        severity: "critical",
        comment: "Avoid using eval() — it executes arbitrary code",
        suggestion: "  const x = safeParser(input)",
      },
    ],
    summary: "Found 1 critical issue.",
  }),
}));

vi.mock("../src/formatter", () => ({
  postReviewComments: vi.fn().mockResolvedValue(undefined),
}));

import { handleWebhook } from "../src/webhook";

const TEST_SECRET = "test-webhook-secret";

function buildTestApp() {
  const app = express();
  app.use("/webhook", express.raw({ type: "application/json" }), handleWebhook);
  return app;
}

async function signBody(body: string): Promise<string> {
  const webhooks = new Webhooks({ secret: TEST_SECRET });
  return webhooks.sign(body);
}

const validPayload = {
  action: "opened",
  number: 42,
  repository: {
    name: "hello-world",
    owner: { login: "octocat" },
  },
  pull_request: {
    head: { sha: "abc1234def5678" },
  },
};

describe("handleWebhook", () => {
  beforeEach(() => {
    // We set the secret here, right before the test runs!
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    vi.clearAllMocks();
  });

  it("returns 200 and ignores non-pull_request events", async () => {
    const app = buildTestApp();
    const body = JSON.stringify({ action: "created" });
    const sig = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "push")          
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/ignored/);
  });

  it("returns 401 when the HMAC signature is missing", async () => {
    const app = buildTestApp();
    const body = JSON.stringify(validPayload);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing signature/);
  });

  it("returns 401 when the HMAC signature is wrong", async () => {
    const app = buildTestApp();
    const body = JSON.stringify(validPayload);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", "sha256=badhash0000000000000000000000000000000000000000000000000000000000")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid signature/);
  });

  it("returns 200 and ignores 'closed' PR actions", async () => {
    const app = buildTestApp();
    const body = JSON.stringify({ ...validPayload, action: "closed" });
    const sig = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/ignored/);
  });

  it("returns 202 and starts a review for an 'opened' PR", async () => {
    const app = buildTestApp();
    const body = JSON.stringify(validPayload);
    const sig = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.message).toBe("Review started");
  });

  it("returns 202 and starts a review for a 'synchronize' PR (new commit pushed)", async () => {
    const app = buildTestApp();
    const body = JSON.stringify({ ...validPayload, action: "synchronize" });
    const sig = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(202);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const app = buildTestApp();
    const badBody = "this is not json {{{";
    const sig = await signBody(badBody);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(badBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid JSON/);
  });

  it("returns 400 when required payload fields are missing", async () => {
    const app = buildTestApp();
    const badPayload = { action: "opened", number: 1, repository: { name: "r", owner: { login: "o" } } };
    const body = JSON.stringify(badPayload);
    const sig = await signBody(body);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unexpected payload shape/);
  });
});