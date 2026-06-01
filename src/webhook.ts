// ─── webhook.ts ──────────────────────────────────────────────────────────────
// This file is the "front door" of the application.
// Its only job: receive a raw HTTP request from GitHub, prove it's genuine,
// decode the payload, and hand off to the review pipeline.
//
// The two concepts to understand here:
//   1. HMAC verification  — proves GitHub sent this, not a random attacker
//   2. Payload validation — proves the JSON has the shape we expect (via zod)
// ─────────────────────────────────────────────────────────────────────────────

import type { Request, Response } from "express";
import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import { fetchAndParseDiff } from "./github";
import { reviewDiff } from "./reviewer";
import { postReviewComments } from "./formatter";

// ─── 1. Signature verifier ────────────────────────────────────────────────────
// We create ONE Webhooks instance at module load time (not inside the handler).
// It holds the secret and exposes a .verify() method.
//
// How HMAC works in plain English:
//   - When you register the webhook on GitHub, you give it a secret string.
//   - Every time GitHub sends a request, it hashes the body bytes WITH that
//     secret using SHA-256, and includes the result in the X-Hub-Signature-256
//     header.
//   - We do the same hash on our side and compare. If they match → genuine.
//   - An attacker without the secret can't forge a valid signature.
function getWebhooks(): Webhooks {
  const secret = process.env.GITHUB_WEBHOOK_SECRET as string;
  
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET env var is not set");
  return new Webhooks({ secret });
}

// ─── 2. Zod schema for the payload ───────────────────────────────────────────
// Zod lets you describe the exact shape you expect and then PARSE incoming data
// against that shape. If the data doesn't match, .safeParse() returns an error
// instead of crashing deep inside your code with "cannot read property of undefined".
//
// We only declare the fields we actually use — GitHub sends ~80 fields per event,
// but we only need four of them.
const prPayloadSchema = z.object({
  action: z.string(),
  number: z.number(),
  repository: z.object({
    name: z.string(),
    owner: z.object({
      login: z.string(),
    }),
  }),
  pull_request: z.object({
    head: z.object({
      sha: z.string(),
    }),
  }),
});

// ─── 3. The handler ──────────────────────────────────────────────────────────
// Express calls this function for every POST /webhook request.
// req.body is a Buffer (raw bytes) because we used express.raw() in index.ts.
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  // ── Step A: Check this is a pull_request event ──────────────────────────
  // GitHub sends an X-GitHub-Event header telling us what type of event this is.
  // We only care about "pull_request" events. We acknowledge everything else
  // with a 200 (so GitHub doesn't retry) but do nothing.
  const eventType = req.headers["x-github-event"];
  if (eventType !== "pull_request") {
    res.status(200).json({ message: `Event '${eventType}' ignored` });
    return;
  }

  // ── Step B: Verify the HMAC signature ───────────────────────────────────
  // req.body is a Buffer. We convert it to a string for the verifier.
  // The signature comes from the X-Hub-Signature-256 header.
  const signature = req.headers["x-hub-signature-256"];
  if (typeof signature !== "string") {
    console.warn("⚠️  Request missing X-Hub-Signature-256 header — rejected");
    res.status(401).json({ error: "Missing signature header" });
    return;
  }

  const rawBody = req.body as Buffer;
  const isValid = await getWebhooks().verify(rawBody.toString(), signature);
  if (!isValid) {
    // This means either:
    //   a) The GITHUB_WEBHOOK_SECRET in your .env doesn't match what you set on GitHub
    //   b) Someone is trying to spoof a webhook request to your server
    console.warn("⚠️  Invalid webhook signature — request rejected");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // ── Step C: Parse + validate the JSON payload ────────────────────────────
  // Now we know the bytes are genuine, we can safely parse the JSON.
  // JSON.parse can throw, so we wrap it. Then we validate the shape with zod.
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody.toString());
  } catch {
    res.status(400).json({ error: "Body is not valid JSON" });
    return;
  }

  const result = prPayloadSchema.safeParse(rawPayload);
  if (!result.success) {
    // result.error.flatten() gives a clean summary of which fields were wrong.
    console.error("❌ Payload shape unexpected:", result.error.flatten());
    res.status(400).json({ error: "Unexpected payload shape" });
    return;
  }

  const payload = result.data;

  // ── Step D: Filter to only the actions we want to review ────────────────
  // GitHub sends pull_request events for many actions:
  //   "opened"      → new PR just created        ✅ we review this
  //   "synchronize" → new commit pushed to the PR ✅ we review this
  //   "closed"      → PR merged or closed         ❌ nothing to review
  //   "labeled"     → someone added a label       ❌ nothing to review
  //   ... etc.
  const reviewableActions = ["opened", "synchronize"];
  if (!reviewableActions.includes(payload.action)) {
    console.log(`ℹ️  PR action '${payload.action}' — no review needed`);
    res.status(200).json({ message: `Action '${payload.action}' ignored` });
    return;
  }

  // ── Step E: Acknowledge GitHub immediately, then do the work ────────────
  // GitHub expects a response within 10 seconds or it marks the delivery as
  // failed and retries. Our AI review takes longer than that.
  // Solution: respond 202 Accepted right now, then do the work asynchronously.
  // The "fire and forget" pattern: we don't await the pipeline here.
  res.status(202).json({ message: "Review started" });

  // ── Step F: Run the review pipeline (async, after response is sent) ──────
  const owner = payload.repository.owner.login; // Extracts the actual username string!
  const repo = payload.repository.name;
  const prNumber = payload.number;
  const commitSha = payload.pull_request.head.sha;

  console.log(`\n🔍 Starting review: ${owner}/${repo} PR #${prNumber} (${commitSha.slice(0, 7)})`);

  // We wrap the whole pipeline in a try/catch so an error doesn't crash the server.
  // Since we already sent the response, we just log the error.
  runReviewPipeline(owner, repo, prNumber, commitSha).catch((err: unknown) => {
    console.error(`❌ Review pipeline failed for PR #${prNumber}:`, err);
  });
}

// ─── 4. The review pipeline ──────────────────────────────────────────────────
// This is a private helper that orchestrates the three phases:
//   fetch diff → AI review → post comments
// It's a separate function so the error handling in the handler stays clean.
async function runReviewPipeline(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string
): Promise<void> {
  // Phase 3: fetch and parse the diff
  console.log(`  📥 Fetching diff for PR #${prNumber}...`);
  const parsedFiles = await fetchAndParseDiff(owner, repo, prNumber);
  console.log(`  📄 Got ${parsedFiles.length} changed file(s)`);

  if (parsedFiles.length === 0) {
    console.log("  ℹ️  No changed files found — skipping review");
    return;
  }

  // Phase 4: send to AI reviewer
  console.log(`  🤖 Sending diff to gemini for review...`);
  const reviewResult = await reviewDiff(parsedFiles);
  console.log(`  💬 Got ${reviewResult.findings.length} finding(s)`);

  // Phase 4: post comments back to GitHub
  console.log(`  📝 Posting comments to PR #${prNumber}...`);
  await postReviewComments(owner, repo, prNumber, commitSha, reviewResult);
  console.log(`  ✅ Review complete for PR #${prNumber}`);
}