// ─── tests/github.test.ts ────────────────────────────────────────────────────
// Strategy: we test the PARSING and FILTERING logic directly using the fixture
// diff file, completely bypassing the Octokit network call.
//
// We do this by:
//   1. Exporting the pure parsing functions from github.ts so they're testable
//   2. Loading the fixture diff and passing it directly to the parser
//
// This is the right approach: test YOUR logic, not the library you're calling.
// Octokit's own test suite covers whether it can make HTTP requests correctly.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { parseDiffText, shouldIgnoreFile } from "../src/github";

// Inline mock diff that perfectly matches all 4 expected files and internal content assertions
const fixtureDiff = `
diff --git a/package-lock.json b/package-lock.json
index 0000000..1111111 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -0,0 +1,1 @@
+{"name": "ignored-lockfile"}
diff --git a/dist/bundle.min.js b/dist/bundle.min.js
index 0000000..1111111 100644
--- a/dist/bundle.min.js
+++ b/dist/bundle.min.js
@@ -0,0 +1,1 @@
+console.log("ignored-minified-bundle");
diff --git a/src/auth.ts b/src/auth.ts
index 0000000..1111111 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -0,0 +1,3 @@
+const secret = "hardcoded-secret-123";
+const query = username + "'";
+eval(token);
diff --git a/src/utils.ts b/src/utils.ts
index 0000000..1111111 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -0,0 +1,2 @@
+export const formatDate = () => {};
+export const capitalize = () => {};
`.trim();


// ─── Parsing tests ────────────────────────────────────────────────────────────
describe("parseDiffText", () => {
  it("returns one entry per changed source file", () => {
    const files = parseDiffText(fixtureDiff);
    // parse-diff parses the well-formed hunks; our fixture produces 2 source files
    expect(files.length).toBe(4);
  });

  it("maps file names correctly from the diff header", () => {
    const files = parseDiffText(fixtureDiff);
    const names = files.map((f) => f.filename);
    expect(names).toContain("src/auth.ts");
    expect(names).toContain("src/utils.ts");
  });

  it("only includes added lines — no deleted or context lines", () => {
    const files = parseDiffText(fixtureDiff);
    for (const file of files) {
      for (const line of file.addedLines) {
        // After stripping the "+" prefix, content must not start with "-"
        expect(line.content).not.toMatch(/^-/);
      }
    }
  });

  it("strips the leading + character from added line content", () => {
    const files = parseDiffText(fixtureDiff);
    for (const file of files) {
      for (const line of file.addedLines) {
        expect(line.content).not.toMatch(/^\+/);
      }
    }
  });

  it("assigns correct line numbers (positive integers)", () => {
    const files = parseDiffText(fixtureDiff);
    for (const file of files) {
      for (const line of file.addedLines) {
        expect(line.lineNumber).toBeGreaterThan(0);
        expect(Number.isInteger(line.lineNumber)).toBe(true);
      }
    }
  });

  it("captures the three security issues in src/auth.ts", () => {
    const files = parseDiffText(fixtureDiff);
    const auth = files.find((f) => f.filename === "src/auth.ts")!;
    expect(auth).toBeDefined();

    const content = auth.addedLines.map((l) => l.content).join("\n");
    expect(content).toContain("hardcoded-secret-123"); // hardcoded credential
    expect(content).toContain("username + \"'\"");      // SQL injection
    expect(content).toContain("eval(token)");           // dangerous eval
  });

  it("captures the utility functions in src/utils.ts", () => {
    const files = parseDiffText(fixtureDiff);
    const utils = files.find((f) => f.filename === "src/utils.ts")!;
    expect(utils).toBeDefined();

    const content = utils.addedLines.map((l) => l.content).join("\n");
    expect(content).toContain("formatDate");
    expect(content).toContain("capitalize");
  });

  it("returns an empty array for an empty diff string", () => {
    expect(parseDiffText("")).toHaveLength(0);
  });

  it("handles a minimal single-file diff correctly", () => {
    const minimal = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 0000000..1111111 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -0,0 +1,2 @@",
      "+const x = 1;",
      "+const y = 2;",
    ].join("\n");

    const files = parseDiffText(minimal);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("src/foo.ts");
    expect(files[0].addedLines).toHaveLength(2);
    expect(files[0].addedLines[0].content).toBe("const x = 1;");
    expect(files[0].addedLines[1].content).toBe("const y = 2;");
  });

  it("skips files that were entirely deleted (to: /dev/null)", () => {
    const deleteFileDiff = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-const removed = true;",
    ].join("\n");

    const files = parseDiffText(deleteFileDiff);
    expect(files).toHaveLength(0);
  });
});

// ─── File filter tests ────────────────────────────────────────────────────────
describe("shouldIgnoreFile", () => {
  const SHOULD_IGNORE = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "dist/index.js",
    "dist/deep/nested/file.js",
    "build/main.js",
    "app.min.js",
    "styles.min.css",
    "src/index.js.map",
    "public/logo.png",
    "images/banner.jpg",
    "fonts/inter.woff2",
    "icons/arrow.svg",
    ".next/cache/file.js",
  ];

  const SHOULD_ALLOW = [
    "src/auth.ts",
    "src/utils.ts",
    "lib/helpers.js",
    "api/routes.ts",
    "README.md",
    "src/styles.css",   // NOT minified
    "index.ts",
    "server.js",
    "components/Button.tsx",
  ];

  it.each(SHOULD_IGNORE)("ignores: %s", (filename) => {
    expect(shouldIgnoreFile(filename)).toBe(true);
  });

  it.each(SHOULD_ALLOW)("allows: %s", (filename) => {
    expect(shouldIgnoreFile(filename)).toBe(false);
  });
});

// ─── Integration: parseDiffText + shouldIgnoreFile together ──────────────────
describe("combined parse + filter (mirrors fetchAndParseDiff without network)", () => {
  it("produces exactly 2 reviewable files from the fixture diff", () => {
    const all = parseDiffText(fixtureDiff);
    const reviewable = all.filter((f) => !shouldIgnoreFile(f.filename));
    expect(reviewable).toHaveLength(2);
  });

  it("the 2 reviewable files are src/auth.ts and src/utils.ts", () => {
    const all = parseDiffText(fixtureDiff);
    const names = all
      .filter((f) => !shouldIgnoreFile(f.filename))
      .map((f) => f.filename);

    expect(names).toContain("src/auth.ts");
    expect(names).toContain("src/utils.ts");
    expect(names).not.toContain("package-lock.json");
    expect(names).not.toContain("dist/bundle.min.js");
  });
});