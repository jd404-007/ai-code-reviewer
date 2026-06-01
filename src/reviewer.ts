import { GoogleGenerativeAI } from "@google/generative-ai";
// import { GoogleGenerativeAI } from "@google/genai";
import type { ParsedFile, ReviewResult, ReviewFinding } from "./types";

let _genAI: GoogleGenerativeAI | null = null;

function getGenAIClient(): GoogleGenerativeAI {
  if (!_genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY env var is not set");
    _genAI = new GoogleGenerativeAI(apiKey);
  }
  return _genAI;
}

const MODEL = "gemini-2.5-flash";
const MAX_TOKENS = 4096;

export async function reviewDiff(files: ParsedFile[]): Promise<ReviewResult> {
  const diffText = formatDiffForPrompt(files);
  const rawResponse = await callGemini(diffText);
  return parseAIResponse(rawResponse, files);
}

function formatDiffForPrompt(files: ParsedFile[]): string {
  return files
    .map((file) => {
      const lines = file.addedLines.map((l) => `Line ${l.lineNumber}: ${l.content}`).join("\n");
      return `## File: ${file.filename}\n${lines}`;
    })
    .join("\n\n");
}

async function callGemini(diffText: string): Promise<string> {
  const genAI = getGenAIClient();
  const systemPrompt = `You are a senior software engineer performing a security code review.
Given the added lines from a pull request, identify vulnerabilities, bugs, and dangerous patterns.

CRITICAL INSTRUCTIONS FOR CONCISENESS:
- Keep the "comment" to a maximum of 2 sentences. Be direct.
- Keep the "suggestion" brief. Only show the exact line change, not the whole function.
- Do not repeat explanations. Combine similar findings if possible.

You MUST respond with ONLY a valid JSON object matching this shape:
{
  "findings": [
    {
      "file": "filename",
      "line": 10,
      "severity": "critical" | "warning" | "info",
      "comment": "explanation",
      "suggestion": "fixed code"
    }
  ],
  "summary": "overall review text"
}`;

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: MAX_TOKENS, responseMimeType: "application/json" },
  });

  const result = await model.generateContent(`Review these lines:\n\n${diffText}`);
  return result.response.text();
}

function parseAIResponse(raw: string, files: ParsedFile[]): ReviewResult {
  const validLines = new Map<string, Set<number>>();
  for (const file of files) {
    validLines.set(file.filename, new Set(file.addedLines.map((l) => l.lineNumber)));
  }

  // FIX 1: Markdown (```json) hatane ke liye
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1].startsWith("```")) lines.pop();
    cleaned = lines.join("\n").trim();
  }
  
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    // ✅ FIXED: Added visible logging so you can debug what broke in your terminal console
    console.error("❌ AI Reviewer Parsing Failed!");
    console.error("--- RAW GEMINI RESPONSE START ---");
    console.log(cleaned);
    console.error("--- RAW GEMINI RESPONSE END ---");
    console.error("Parse Error Details:", error);

    return { findings: [], summary: "Review could not be parsed." };
  }

  if (!parsed || !Array.isArray(parsed.findings)) {
    return { findings: [], summary: "Review format was unexpected." };
  }

  const VALID_SEVERITIES = new Set(["critical", "warning", "info"]);
  const findings: ReviewFinding[] = [];

  for (const item of parsed.findings) {
    if (!item || typeof item !== "object") continue;

    if (typeof item.file !== "string" || typeof item.comment !== "string" || typeof item.suggestion !== "string") {
      continue;
    }

    const lineNum = typeof item.line === "number" ? item.line : parseInt(String(item.line), 10);
    if (isNaN(lineNum)) continue;

    const validLineSet = validLines.get(item.file);
    if (!validLineSet) continue;

    let finalLine = lineNum;
    if (!validLineSet.has(lineNum)) {
      finalLine = findClosestLine(lineNum, validLineSet);
    }

    const sev = String(item.severity ?? "").toLowerCase();
    const severity = VALID_SEVERITIES.has(sev) ? (sev as ReviewFinding["severity"]) : "warning";

    findings.push({
      file: item.file,
      line: finalLine,
      severity,
      comment: item.comment,
      suggestion: item.suggestion,
    });
  }

  let finalSummary = parsed.summary;
  if (typeof finalSummary !== "string" || finalSummary.trim() === "") {
    if (findings.length === 0) {
      finalSummary = "No issues found. Code looks clean.";
    } else {
      const counts = { critical: 0, warning: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;

      const parts: string[] = [];
      if (counts.critical > 0) parts.push(`${counts.critical} critical`);
      if (counts.warning > 0)  parts.push(`${counts.warning} warning`);
      if (counts.info > 0)     parts.push(`${counts.info} info`);

      finalSummary = `Found ${parts.join(", ")} issues.`;
    }
  } else {
    finalSummary = finalSummary.trim();
  }

  return {
    findings,
    summary: finalSummary,
  };
}

function findClosestLine(target: number, validLines: Set<number>): number {
  let closest = 0;
  let minDist = Infinity;
  for (const n of validLines) {
    const dist = Math.abs(n - target);
    if (dist < minDist) {
      minDist = dist;
      closest = n;
    }
  }
  return closest;
}