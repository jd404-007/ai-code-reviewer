# 🤖 AI Code Reviewer

An AI-powered GitHub PR review agent built with TypeScript, Express, and Gemini.
When a PR is opened or updated, it automatically posts inline comments with
security findings and one-click fix suggestions.

---

## What it does

- Listens for GitHub `pull_request` webhook events
- Verifies every request with HMAC-SHA256 signatures (security)
- Fetches the PR diff and filters out lock files, minified bundles, etc.
- Sends the changed lines to Gemini with a security-focused review prompt
- Posts inline comments with `suggestion` blocks (one-click apply in GitHub UI)
- Summarises findings in a top-level review comment with a severity table

---

## Stack

| Layer       | Technology                                        |
|-------------|---------------------------------------------------|
| Runtime     | Node.js 18+ / TypeScript (ESM)                    |
| Server      | Express + `express.raw()`                         |
| GitHub API  | `@octokit/rest` + `@octokit/webhooks`             |
| AI          | Gemini via `@google/genai`                        |
| Diff parser | `parse-diff`                                      |
| Validation  | `zod`                                             |
| Testing     | `vitest` + `supertest`                            |
| Deployment  | Railway                                           |

---

## ⚠️ ESM-only project

This project uses **`"type": "module"`** in `package.json` and TypeScript is compiled with `"module": "NodeNext"`. This is required because `@octokit/rest` and `@octokit/webhooks` are ESM-only packages — they dropped CommonJS support and will throw `ERR_REQUIRE_ESM` if you try to `require()` them.

**What this means for you:**
- All source files use `import`/`export` syntax — no `require()`
- `tsconfig.json` must use `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`
- Import paths in TypeScript must include the `.js` extension (e.g. `import { foo } from './utils.js'`)
- Test files with `vitest` work fine since vitest handles ESM natively

**If you hit `ERR_REQUIRE_ESM`** after cloning: double check your `package.json` has `"type": "module"` and your `tsconfig.json` matches the one in this repo exactly.

---

## Local setup

### 1. Clone and install

```bash
git clone https://github.com/jd404-007/ai-code-reviewer
cd ai-code-reviewer
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Then fill in the values:

```
GITHUB_TOKEN=ghp_...          # Personal Access Token (see below)
GITHUB_WEBHOOK_SECRET=...     # Any random string — you'll use this in step 4
GEMINI_API_KEY=...            # From aistudio.google.com
PORT=3000
```

**Getting a GitHub Personal Access Token:**
1. Go to github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a name like "ai-code-reviewer"
4. Check the `repo` scope (needed to read diffs and post comments)
5. Copy the token — you only see it once

**Getting a Gemini API Key:**
1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click "Get API key" → Create API key
3. Copy the key into your `.env`

### 3. Run locally

```bash
npm run dev
# Server starts at http://localhost:3000
# Webhook endpoint: http://localhost:3000/webhook
# Health check:     http://localhost:3000/health
```

The dev script uses `tsx` to run TypeScript directly with hot-reload via `--watch`.

---

## Live Deployment

The project is already deployed and running at:

```
https://ai-code-reviewer-production-3d67.up.railway.app
```

| Endpoint | URL |
|----------|-----|
| Health check | `https://ai-code-reviewer-production-3d67.up.railway.app/health` |
| Webhook (for GitHub) | `https://ai-code-reviewer-production-3d67.up.railway.app/webhook` |

To use this with your own GitHub repo, just register the webhook URL above — see [Registering the GitHub webhook](#registering-the-github-webhook) below.

---

## Registering the GitHub webhook

Do this for every repo you want automatically reviewed.

1. Go to your GitHub repo → **Settings** → **Webhooks** → **Add webhook**
2. Fill in:
   - **Payload URL**: `https://ai-code-reviewer-production-3d67.up.railway.app/webhook`
   - **Content type**: `application/json`
   - **Secret**: the same value as `mysecretangelsofiaprincess123@` from the deployment
   - **Which events**: select "Let me select individual events" → check **Pull requests**
3. Click **Add webhook**

GitHub will send a test ping. You should see a message that port is running within seconds.

To verify it's working:
- Open a PR in the repo
- The PR should get inline comments within ~20 seconds

---

## Testing locally with ngrok

Before deploying to Railway, the project was tested locally using **ngrok** — a tool that creates a secure public HTTPS tunnel to your local machine. This is the bridge that lets GitHub reach your locally-running server: GitHub needs a real public URL to send webhook events to, and ngrok provides one that forwards straight to `localhost:3000`.

```
GitHub webhook event
       │
       ▼
ngrok public URL  ──►  localhost:3000  ──►  Express server
(temporary HTTPS)           │
                            ▼
                      Gemini API review
                            │
                            ▼
                  GitHub inline PR comments
```

### Setting up ngrok

**1. Install ngrok**

```bash
# macOS
brew install ngrok

# Or download directly from https://ngrok.com/download
```

**2. Sign up and add your authtoken** (free tier is enough)

```bash
ngrok config add-authtoken YOUR_AUTHTOKEN
```

**3. Start your local server**

```bash
npm run dev
# Server running at http://localhost:3000
```

**4. In a separate terminal, start ngrok**

```bash
ngrok http 3000
```

You'll see output like:

```
Forwarding  https://a1b2-103-x-x-x.ngrok-free.app -> http://localhost:3000
```

Copy that `https://...ngrok-free.app` URL — this is your temporary public webhook URL.

**5. Register it as your GitHub webhook**

Go to your repo → **Settings** → **Webhooks** → **Add webhook**, and use:

```
https://a1b2-103-x-x-x.ngrok-free.app/webhook
```

Set the secret to match `GITHUB_WEBHOOK_SECRET` in your `.env`.

**6. Open a PR and watch the logs**

With both `npm run dev` and `ngrok` running, open a pull request in the repo. You'll see the webhook hit in your terminal in real time, and the PR will receive inline review comments from Gemini within seconds.

> **Note:** ngrok URLs are temporary — they change every time you restart ngrok (on the free plan). For persistent testing, pin a static domain in ngrok's dashboard, or just use the deployed Railway URL.

---

## Deployment to Railway (for reference)

The project is already deployed, but here's how it was set up for anyone reproducing this.

### Step 1 — Connect your repo

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select `ai-code-reviewer`
3. Railway detects `railway.toml` automatically — no extra config needed

The `railway.toml` in the repo handles the build and start:

```toml
[build]
builder = "NIXPACKS"
buildCommand = "npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

`npm run build` compiles TypeScript to `dist/`, then `npm start` runs `node dist/index.js`.

### Step 2 — Set environment variables

In the Railway dashboard → your service → **Variables** tab, add:

- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `GEMINI_API_KEY`
- `PORT` → `3000`

Railway automatically redeploys after saving.

### Step 3 — Generate a public domain

Dashboard → your service → **Settings** → **Networking** → **Generate Domain**.

### Common Railway issues encountered

**Build succeeds but server crashes on start**
Almost always a missing environment variable. Check the Variables tab — a missing `GITHUB_TOKEN` or `GEMINI_API_KEY` crashes the server at startup before it can bind.

**`ERR_REQUIRE_ESM` in Railway logs**
Octokit is ESM-only, so the entire project must be ESM. Ensure `"type": "module"` is in `package.json` and `tsconfig.json` uses `"module": "NodeNext"`. If it's already correct but still failing, trigger a manual redeploy to clear Railway's build cache.

**Port binding errors / service not reachable**
Railway injects `PORT` automatically into the environment. Never hard-code a port in `index.ts` — always read `process.env.PORT`, otherwise Railway can't route traffic to the container.

**`tsx` not found in production**
`tsx` is a dev dependency used only for `npm run dev`. Production runs the compiled `dist/index.js` via `npm start` — never the TypeScript source directly.

---

## Running tests

```bash
npm test                          # all tests
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
├── reviewer.ts   — Sends diff to Gemini, parses structured response
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
  Gemini API (system prompt enforces JSON schema)
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

**"Invalid signature" errors**
Your `GITHUB_WEBHOOK_SECRET` in `.env` doesn't match what you typed into GitHub's webhook settings. They must be byte-for-byte identical.

**No comments appearing on PRs**
Check Railway logs. If you see "Review pipeline failed", the most common cause is an expired `GITHUB_TOKEN`. Regenerate it at github.com/settings/tokens.

**"GITHUB_TOKEN env var is not set" in logs**
The Railway environment variables weren't saved. Go back to the Variables tab and make sure all four are present and the service was redeployed after saving.

**Gemini returning "could not be parsed"**
Rare, but can happen if the diff is very large and hits token limits. The fallback message is posted as the review summary. If you regularly review large PRs, split them into smaller focused commits.

**`ERR_REQUIRE_ESM` locally**
Make sure you haven't accidentally added `require()` calls anywhere. All imports must use ES module `import` syntax. Also check that your Node.js version is 18 or higher (`node --version`).
