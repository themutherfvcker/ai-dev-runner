#!/usr/bin/env node
/**
 * Generic AI Dev Runner — Claude Edition
 * - Runs inside a target repo directory (process.cwd()).
 * - Builds file tree + selects relevant context files.
 * - Always injects docs/SOURCE_OF_TRUTH.md if present.
 * - Calls Anthropic Claude and applies @@FILE blocks as full-file overwrites.
 * - Opens a GitHub PR instead of committing directly to main.
 *
 * Usage (from target repo):
 *   node ../runner/scripts/ai-dev.mjs "your task here"
 *
 * Env:
 *   ANTHROPIC_API_KEY        (required)
 *   ANTHROPIC_MODEL          (optional, default: claude-opus-4-6 for complex, claude-sonnet-4-6 for simple)
 *   AI_DEV_MAX_CONTEXT_CHARS (optional, default: 180000)
 *   AI_DEV_MAX_FILES         (optional, default: 35)
 *   AI_DEV_FORCE_MODEL       (optional, override auto model selection)
 */

import fs from "fs";
import path from "path";
import process from "process";
import Anthropic from "@anthropic-ai/sdk";

// ---------- Config ----------
const MAX_CONTEXT_CHARS = Number(process.env.AI_DEV_MAX_CONTEXT_CHARS || "180000");
const MAX_FILES = Number(process.env.AI_DEV_MAX_FILES || "35");

// Auto-select model based on task complexity (can be overridden)
const FORCE_MODEL = (process.env.AI_DEV_FORCE_MODEL || "").trim();
const MODEL_COMPLEX = "claude-opus-4-6";   // architectural changes, multi-file refactors
const MODEL_SIMPLE  = "claude-sonnet-4-6"; // targeted fixes, single-file changes

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

// Always include these files in every context window
const ALWAYS_CONTEXT_CANDIDATES = [
  // ← SOURCE_OF_TRUTH.md guaranteed first so AI always knows the non-negotiables
  "docs/SOURCE_OF_TRUTH.md",
  "SOURCE_OF_TRUTH.md",
  "MEMORY.md",
  "docs/MEMORY.md",
  // Standard config files
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

// Paths the AI is never allowed to write to
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

  const ext = path.extname(lower);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx", ".json", ".css", ".scss"].includes(ext)) {
    score += 3;
  }

  if (
    lower.includes("app/") ||
    lower.includes("src/") ||
    lower.includes("pages/") ||
    lower.includes("components/") ||
    lower.includes("lib/") ||
    lower.includes("utils/") ||
    lower.includes("services/")
  ) score += 2;

  for (const k of keywords) {
    if (lower.includes(k)) score += 5;
  }

  return score;
}

// Estimate task complexity to pick the right model
function estimateComplexity(task) {
  if (FORCE_MODEL) return FORCE_MODEL;

  const lower = task.toLowerCase();
  const complexSignals = [
    "refactor", "redesign", "rewrite", "architecture", "migrate",
    "add feature", "new page", "new api", "new component", "integrate",
    "multiple", "across", "all pages", "whole", "entire",
  ];
  const isComplex = complexSignals.some((s) => lower.includes(s));
  return isComplex ? MODEL_COMPLEX : MODEL_SIMPLE;
}

function clampToRepo(relPath) {
  const normalized = relPath.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  if (normalized.startsWith("/") || normalized.startsWith("..") || normalized.includes("/..")) return null;
  return normalized;
}

// Parse @@FILE:...@@ blocks from AI response
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

  // Always include candidates if present in repo
  const always = [];
  for (const p of ALWAYS_CONTEXT_CANDIDATES) {
    if (allFiles.includes(p)) always.push(p);
  }

  // Include any explicit file paths mentioned in the task
  const explicit = [];
  const fileMentionRegex = /([\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss))/gi;
  let m;
  while ((m = fileMentionRegex.exec(task)) !== null) {
    const mentioned = m[1];
    if (allFiles.includes(mentioned) && !explicit.includes(mentioned)) {
      explicit.push(mentioned);
    }
  }

  // Rank remaining files by relevance score
  const ranked = allFiles
    .filter((f) => !always.includes(f) && !explicit.includes(f))
    .map((f) => ({ f, s: scoreFile(f, keywords) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, MAX_FILES - always.length - explicit.length))
    .map((x) => x.f);

  const selected = [...new Set([...always, ...explicit, ...ranked])].slice(0, MAX_FILES);

  // Build context with char budget
  let used = 0;
  const chunks = [];

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

  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) fatal("ANTHROPIC_API_KEY is not set.");

  const client = new Anthropic({ apiKey });
  const model = estimateComplexity(task);

  // Build file list
  const root = process.cwd();
  const allFiles = walkRepo(root)
    .filter((p) => !p.endsWith("/"))
    .filter((p) => !isIgnoredPath(p));

  if (!allFiles.length) fatal("No files found. Are you in the target repo directory?");

  const contextSnippets = buildContext(allFiles, task);

  const systemPrompt = `
You are an expert software engineer working on a production codebase.

You will receive:
- A TASK description
- A repository file tree and selected file contents for context
- Crucially: a SOURCE_OF_TRUTH.md or MEMORY.md if present — read this FIRST and treat it as non-negotiable architectural rules

Your job:
- Make the smallest correct set of changes to implement the task
- ALWAYS check SOURCE_OF_TRUTH.md before making any change — never regress what it defines as non-negotiable
- Output ONLY patches in this exact format (no explanation, no markdown, no extra text):

@@FILE:relative/path/to/file.ext@@
<FULL file contents here>
@@END_FILE@@

Rules:
- Output FULL file contents for each changed/created file (no diffs, no partial files)
- Only include files that actually need to change
- Never write outside the repo (no absolute paths, no ../)
- Do not delete files unless explicitly asked — prefer additive changes
- Preserve existing behaviour unless the task requires changes
- Keep all imports/exports valid and the project compiling
- If SOURCE_OF_TRUTH.md defines a conversion flow, SEO structure, or API contract — do not break it
`.trim();

  const userPrompt = `
TASK:
${task}

REPO CONTEXT:
${contextSnippets}
`.trim();

  console.log(`\n🤖 AI Dev Runner — Claude Edition`);
  console.log(`- Model: ${model}`);
  console.log(`- Repo: ${process.cwd()}`);
  console.log(`- Task: ${task}\n`);

  const response = await client.messages.create({
    model,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [
      { role: "user", content: userPrompt },
    ],
  });

  const aiText = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!aiText) {
    console.error("Claude response contained no text output.");
    console.error(JSON.stringify(response, null, 2));
    process.exit(1);
  }

  let patches = parsePatches(aiText);
  if (!patches.length) {
    console.error("\n❌ No @@FILE blocks found in Claude response. Raw output below:\n");
    console.error(aiText);
    process.exit(1);
  }

  let applied = 0;
  for (const patch of patches) {
    const safeRel = clampToRepo(patch.filePath);

    if (BLOCKED_PREFIXES.some((p) => safeRel && safeRel.startsWith(p))) {
      console.warn(`⛔ Blocked write to protected path: ${safeRel}`);
      continue;
    }

    if (!safeRel) {
      console.warn(`⚠️  Skipping unsafe path: ${patch.filePath}`);
      continue;
    }

    const fullPath = path.join(process.cwd(), safeRel);
    const dirName = path.dirname(fullPath);

    const cleanContent = patch.content
      .replace(/^@@FILE:[^\n]*@@\s*/gm, "")
      .replace(/^@@END_FILE@@\s*/gm, "");

    if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });

    fs.writeFileSync(fullPath, cleanContent, "utf8");
    console.log(`✅ Updated: ${safeRel}`);
    applied++;
  }

  if (!applied) fatal("No patches were applied (all paths were blocked or unsafe).");

  console.log("\n✨ Claude changes applied. Build gate will now validate before PR is opened.\n");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
