#!/usr/bin/env node
/**
 * Generic AI Dev Runner
 * - Runs inside a target repo directory (process.cwd()).
 * - Builds file tree + selects relevant context files.
 * - Calls OpenAI and applies @@FILE blocks as full-file overwrites.
 *
 * Usage (from target repo):
 *   node ../runner/scripts/ai-dev.mjs "your task here"
 *
 * Env:
 *   OPENAI_API_KEY (required)
 *   OPENAI_MODEL (optional, default: gpt-5.1)
 *   AI_DEV_MAX_CONTEXT_CHARS (optional, default: 180000)
 *   AI_DEV_MAX_FILES (optional, default: 35)
 */

import fs from "fs";
import path from "path";
import process from "process";
import OpenAI from "openai";

// ---------- Config ----------
const MODEL = (process.env.OPENAI_MODEL || "gpt-5.1").trim();
const MAX_CONTEXT_CHARS = Number(process.env.AI_DEV_MAX_CONTEXT_CHARS || "180000");
const MAX_FILES = Number(process.env.AI_DEV_MAX_FILES || "35");

// Directories/files to ignore in tree + context selection
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".vercel",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
]);

const IGNORE_FILE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".mp4", ".mov", ".mp3", ".wav",
  ".pdf", ".zip", ".7z",
]);

const ALWAYS_CONTEXT_CANDIDATES = [
  "package.json",
  "README.md",
  "tsconfig.json",
  "tsconfig.base.json",
  "jsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "vercel.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".prettierrc",
  ".prettierrc.json",
  "postcss.config.js",
  "postcss.config.cjs",
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.ts",
];

// ---------- Helpers ----------
function fatal(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function readFileSafe(relPath) {
  const fullPath = path.join(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) return "";
  try {
    return fs.readFileSync(fullPath, "utf8");
  } catch {
    return "";
  }
}

function isIgnoredPath(relPath) {
  const parts = relPath.split(path.sep);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  const ext = path.extname(relPath).toLowerCase();
  if (IGNORE_FILE_EXTS.has(ext)) return true;
  return false;
}

function walkRepo(rootDir, relBase = "") {
  const entries = [];
  const absBase = path.join(rootDir, relBase);
  const items = fs.readdirSync(absBase, { withFileTypes: true });

  for (const item of items) {
    const rel = path.join(relBase, item.name);
    if (isIgnoredPath(rel)) continue;

    if (item.isDirectory()) {
      entries.push(`${rel}/`);
      entries.push(...walkRepo(rootDir, rel));
    } else if (item.isFile()) {
      entries.push(rel);
    }
  }
  return entries;
}

function tokenizeTask(task) {
  // crude keywords: words, file-like tokens, slash paths
  const raw = task
    .toLowerCase()
    .replace(/[`"'(),:;]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const keywords = new Set();
  for (const t of raw) {
    if (t.length < 3) continue;
    keywords.add(t);
  }
  return [...keywords];
}

function scoreFile(relPath, keywords) {
  const lower = relPath.toLowerCase();
  let score = 0;

  // prioritize code + docs
  const ext = path.extname(lower);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx", ".json", ".css", ".scss"].includes(ext)) {
    score += 3;
  }

  // boost obvious “core” files
  if (
    lower.includes("app/") ||
    lower.includes("src/") ||
    lower.includes("pages/") ||
    lower.includes("components/") ||
    lower.includes("lib/") ||
    lower.includes("utils/") ||
    lower.includes("services/")
  ) score += 2;

  // keyword matches
  for (const k of keywords) {
    if (lower.includes(k)) score += 5;
  }

  return score;
}

function clampToRepo(relPath) {
  // Prevent path traversal
  const normalized = relPath.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  if (normalized.startsWith("/") || normalized.startsWith("..") || normalized.includes("/..")) return null;
  return normalized;
}

// Parse @@FILE:...@@ blocks
function parsePatches(aiText) {
  const blocks = [];
  const regex = /@@FILE:([^\n@]+)@@([\s\S]*?)@@END_FILE@@/g;
  let match;
  while ((match = regex.exec(aiText)) !== null) {
    const filePath = match[1].trim();
    const content = match[2].replace(/^\n/, "");
    blocks.push({ filePath, content });
  }
  return blocks;
}

function buildContext(allFiles, task) {
  const keywords = tokenizeTask(task);

  // Always include candidates if present
  const always = [];
  for (const p of ALWAYS_CONTEXT_CANDIDATES) {
    if (allFiles.includes(p)) always.push(p);
  }

  // Include any explicit file paths mentioned in task
  const explicit = [];
  const fileMentionRegex = /([\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss))/gi;
  let m;
  while ((m = fileMentionRegex.exec(task)) !== null) {
    const mentioned = m[1];
    if (allFiles.includes(mentioned) && !explicit.includes(mentioned)) {
      explicit.push(mentioned);
    }
  }

  // Rank remaining files by relevance
  const ranked = allFiles
    .filter((f) => !always.includes(f) && !explicit.includes(f))
    .map((f) => ({ f, s: scoreFile(f, keywords) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, MAX_FILES - always.length - explicit.length))
    .map((x) => x.f);

  const selected = [...new Set([...always, ...explicit, ...ranked])].slice(0, MAX_FILES);

  // Construct context with a char budget
  let used = 0;
  const chunks = [];

  // File tree (always include, but trimmed)
  const treeText = allFiles.slice(0, 1500).join("\n");
  const treeChunk = `\n// REPO_FILE_TREE (truncated)\n${treeText}\n`;
  chunks.push(treeChunk);
  used += treeChunk.length;

  for (const rel of selected) {
    const content = readFileSafe(rel);
    if (!content) continue;

    const chunk = `\n// FILE: ${rel}\n${content}\n`;
    if (used + chunk.length > MAX_CONTEXT_CHARS) break;

    chunks.push(chunk);
    used += chunk.length;
  }

  return chunks.join("\n");
}

// ---------- Main ----------
async function main() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) fatal('Usage: node scripts/ai-dev.mjs "Describe your change here"');

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) fatal("OPENAI_API_KEY is not set.");

  const openai = new OpenAI({ apiKey });

  // Build file list
  const root = process.cwd();
  const allFiles = walkRepo(root)
    .filter((p) => !p.endsWith("/"))
    .filter((p) => !isIgnoredPath(p));

  if (!allFiles.length) fatal("No files found (or everything is ignored). Are you in the target repo directory?");

  const contextSnippets = buildContext(allFiles, task);

  const systemPrompt = `
You are an expert software engineer.

You receive:
- A TASK description.
- A repository file tree and selected file contents for context.

Your job:
- Make the smallest correct set of changes to implement the task.
- Output ONLY patches in this exact format (no extra text):

@@FILE:relative/path/to/file.ext@@
<FULL file contents here>
@@END_FILE@@

Rules:
- Output FULL file contents for each changed/created file (no diffs).
- Only include files that need to change.
- Never write outside the repo (no absolute paths, no ../).
- Do not delete files unless explicitly asked; prefer additive changes.
- Preserve existing behavior unless the task requires changes.
- Keep imports/exports valid and code compiling.
`.trim();

  const userPrompt = `
TASK:
${task}

REPO CONTEXT:
${contextSnippets}
`.trim();

  console.log(`\n🤖 AI Dev Runner`);
  console.log(`- Model: ${MODEL}`);
  console.log(`- Repo: ${process.cwd()}`);
  console.log(`- Task: ${task}\n`);

  const response = await openai.responses.create({
    model: MODEL,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const out = response.output?.[0]?.content?.[0];
  const aiText = out && typeof out.text === "string" ? out.text : "";
  if (!aiText) {
    console.error("AI response did not contain a top-level text output.");
    console.error(JSON.stringify(response, null, 2));
    process.exit(1);
  }

  let patches = parsePatches(aiText);
  if (!patches.length) {
    console.error("\n❌ No @@FILE blocks found. Raw response below:\n");
    console.error(aiText);
    process.exit(1);
  }

  let applied = 0;
  for (const patch of patches) {
    const safeRel = clampToRepo(patch.filePath);
    // 🚫 Never allow AI to modify CI/workflows or other dangerous areas
const BLOCKED_PREFIXES = [
  ".github/",
  ".git/",
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "out/",
  ".vercel/",
];

if (BLOCKED_PREFIXES.some((p) => safeRel.startsWith(p))) {
  console.warn(`⛔ Blocked write: ${safeRel}`);
  continue;
}

    
    if (!safeRel) {
      console.warn(`⚠️ Skipping unsafe path: ${patch.filePath}`);
      continue;
    }

    const fullPath = path.join(process.cwd(), safeRel);
    const dirName = path.dirname(fullPath);

    // Extra safety: strip accidental markers inside content
    const cleanContent = patch.content
      .replace(/^@@FILE:[^\n]*@@\s*/gm, "")
      .replace(/^@@END_FILE@@\s*/gm, "");

    if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });

    fs.writeFileSync(fullPath, cleanContent, "utf8");
    console.log(`✅ Updated: ${safeRel}`);
    applied++;
  }

  if (!applied) fatal("No patches applied (all were unsafe?).");

  console.log("\n✨ AI changes applied. Now run your normal build gate in CI before pushing.\n");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
