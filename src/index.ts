// ─── index.ts ────────────────────────────────────────────────────────────────
// This is the entry point. It does two things:
//   1. Loads environment variables from .env before anything else runs
//   2. Starts the Express HTTP server
//
// Think of it like the "main()" function in other languages.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config"; // Must be the FIRST import — loads .env into process.env

import express from "express";
import { handleWebhook } from "./webhook";

const app = express();
const PORT = process.env.PORT ?? 3000;

// express.raw() gives us the raw request body as a Buffer (bytes), not parsed JSON.
// We need this because GitHub's HMAC signature is computed over the raw bytes —
// if Express parses the JSON first, the bytes change and signature verification fails.
app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook
);

// A simple health-check route — useful for deployment platforms to know the server is alive.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ AI Code Reviewer listening on http://localhost:${PORT}`);
  console.log(`   Webhook endpoint: http://localhost:${PORT}/webhook`);
});