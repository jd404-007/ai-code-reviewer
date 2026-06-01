# 🤖 AI Code Reviewer

An AI-powered GitHub PR review agent built with TypeScript, Express, and Gemini.
When a PR is opened or updated, it automatically posts inline comments with
security findings and one-click fix suggestions.

---

## What it does

- Listens for GitHub `pull_request` webhook events
- Verifies every request with HMAC-SHA256 signatures (security)
- Fetches the PR diff and filters out lock files, minified bundles, etc.
- Sends the changed lines to Claude with a security-focused review prompt
- Posts inline comments with `suggestion` blocks (one-click apply in GitHub UI)
- Summarises findings in a top-level review comment with a severity table

---

## Stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| Runtime     | Node.js 18+ / TypeScript            |
| Server      | Express + `express.raw()`           |
| GitHub API  | `@octokit/rest` + `@octokit/webhooks` |
| AI          | Claude (`claude-sonnet-4-20250514`) via `@anthropic-ai/sdk` |
| Diff parser | `parse-diff`                        |
| Validation  | `zod`                               |
| Testing     | `vitest` + `supertest`              |
| Deployment  | Railway                             |

---

## Local setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/ai-code-reviewer
cd ai-code-reviewer
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Then fill in the three values:

```
GITHUB_TOKEN=ghp_...          # Personal Access Token (see below)
GITHUB_WEBHOOK_SECRET=...     # Any random string — you'll use this in step 4
ANTHROPIC_API_KEY=sk-ant-...  # From console.anthropic.com
PORT=3000
```

**Getting a GitHub Personal Access Token:**
1. Go to github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a name like "ai-code-reviewer"
4. Check the `repo` scope (needed to read diffs and post comments)
5. Copy the token — you only see it once

### 3. Run locally

```bash
npm run dev
# Server starts at http://localhost:3000
# Webhook endpoint: http://localhost:3000/webhook
# Health check:     http://localhost:3000/health
```

---

## Deployment to Railway

Railway gives you a free public HTTPS URL in under 2 minutes.

### Step 1 — Deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create a new project and deploy
railway init        # creates a new project
railway up          # deploys from your current directory
```

### Step 2 — Set environment variables

In the Railway dashboard (railway.app):
1. Open your project → click your service → **Variables** tab
2. Add all four variables from your `.env` file:
   - `GITHUB_TOKEN`
   - `GITHUB_WEBHOOK_SECRET`
   - `ANTHROPIC_API_KEY`
   - `PORT` → set to `3000`

### Step 3 — Get your public URL

In Railway dashboard → your service → **Settings** → **Networking** → **Generate Domain**.

Your webhook URL will be: `https://your-service.up.railway.app/webhook`

---

## Registering the GitHub webhook

Do this for every repo you want reviewed.

1. Go to your GitHub repo → **Settings** → **Webhooks** → **Add webhook**
2. Fill in:
   - **Payload URL**: `https://your-service.up.railway.app/webhook`
   - **Content type**: `application/json`
   - **Secret**: the same value as `GITHUB_WEBHOOK_SECRET` in your `.env`
   - **Which events**: select "Let me select individual events" → check **Pull requests**
3. Click **Add webhook**

GitHub will send a test ping. You should see a ✅ green checkmark within seconds.

To verify it's working:
- Open a PR in the repo
- Check Railway logs (`railway logs`) — you should see the review pipeline running
- The PR should get inline comments within ~20 seconds

---

## Running tests

```bash
npm test                          # all 91 tests
npx vitest run tests/e2e.test.ts  # end-to-end only
npx vitest --watch                # watch mode during development
```

### Test coverage by module

| File                     | What's tested                                          | Tests |
|--------------------------|--------------------------------------------------------|-------|
| `webhook.test.ts`        | HMAC verification, payload validation, event filtering | 8     |
| `github.test.ts`         | Diff parsing, file filtering, line extraction          | 35    |
| `reviewer.test.ts`       | Prompt parsing, defensive handling, edge cases         | 19    |
| `formatter.test.ts`      | Comment format, suggestion blocks, review body         | 19    |
| `e2e.test.ts`            | Full pipeline, async behavior, error resilience        | 10    |

---

## Project structure

```
src/
├── index.ts      — Entry point, starts Express server
├── webhook.ts    — Receives & verifies GitHub webhook
├── github.ts     — Fetches PR diff via Octokit, parses with parse-diff
├── reviewer.ts   — Sends diff to Claude, parses structured response
├── formatter.ts  — Formats findings as GitHub review comments
└── types.ts      — Shared TypeScript interfaces

tests/
├── fixtures/
│   └── sample.diff          — Real diff with intentional security issues
├── webhook.test.ts
├── github.test.ts
├── reviewer.test.ts
├── formatter.test.ts
└── e2e.test.ts              — Full pipeline integration test
```

---

## How the review pipeline works

```
GitHub PR opened/updated
        │
        ▼
POST /webhook  ←─── X-Hub-Signature-256 (HMAC-SHA256)
        │
        ▼
Verify signature + validate payload (zod)
        │
        ▼
Respond 202 immediately ──► fire-and-forget pipeline
        │
        ▼
fetchAndParseDiff()
  Octokit pulls.get (mediaType: diff)
  parse-diff → structured chunks
  Filter lock files, minified, binaries
        │
        ▼
reviewDiff()
  Format diff as "Line N: <code>"
  gemini API (system prompt enforces JSON schema)
  Parse + validate response defensively
        │
        ▼
postReviewComments()
  Build inline comments with ```suggestion blocks
  Build summary with severity table
  pulls.createReview (single API call)
        │
        ▼
PR updated with inline comments + summary
```

---

## Common issues

