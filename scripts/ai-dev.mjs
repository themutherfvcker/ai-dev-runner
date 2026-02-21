#!/usr/bin/env node
/**
 * AI Dev Runner — Multi-Model Edition
 * Supports: Anthropic Claude, OpenAI (incl. Azure), Google Gemini, Ollama (local)
 *
 * Model is detected automatically from the AI_DEV_MODEL env var prefix:
 *   claude-*           → Anthropic
 *   gpt-* / o1* / o3*  → OpenAI
 *   gemini-*           → Google Gemini
 *   ollama:*           → Local Ollama (e.g. ollama:llama3)
 *
 * Usage (from target repo root):
 *   node ../runner/scripts/ai-dev.mjs "your task description"
 *
 * Environment variables:
 *   AI_DEV_MODEL              Model string (default: claude-sonnet-4-6)
 *   ANTHROPIC_API_KEY         Required for claude-* models
 *   OPENAI_API_KEY            Required for gpt-* / o* models
 *   AZURE_OPENAI_API_KEY      Required for Azure OpenAI
 *   AZURE_OPENAI_ENDPOINT     Required for Azure OpenAI
 *   AZURE_OPENAI_API_VERSION  Optional (default: 2024-02-01)
 *   GOOGLE_API_KEY            Required for gemini-* models
 *   OLLAMA_HOST               Optional Ollama host (default: http://localhost:11434)
 *   AI_DEV_MAX_CONTEXT_CHARS  Max context chars (default: 180000)
 *   AI_DEV_MAX_FILES          Max files in context (default: 35)
 *
 * Output format (AI must return this):
 *   @@FILE:relative/path/to/file.ext@@
 *   <full file contents>
 *   @@END_FILE@@
 */

import fs from "fs";
import path from "path";
import process from "process";

// ─── Config ──────────────────────────────────────────────────────────────────

const AI_DEV_MODEL         = (process.env.AI_DEV_MODEL || "claude-sonnet-4-6").trim();
const MAX_CONTEXT_CHARS    = Number(process.env.AI_DEV_MAX_CONTEXT_CHARS || "180000");
const MAX_FILES            = Number(process.env.AI_DEV_MAX_FILES || "35");

const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out",
  ".vercel", ".turbo", ".cache", "coverage", ".idea", ".vscode",
]);

const IGNORE_FILE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".mp4", ".mov", ".mp3", ".wav", ".pdf", ".zip", ".7z",
]);

// Always injected first — AI reads these before touching anything
const ALWAYS_CONTEXT_CANDIDATES = [
  "docs/SOURCE_OF_TRUTH.md",
  "SOURCE_OF_TRUTH.md",
  "MEMORY.md",
  "docs/MEMORY.md",
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
  ".eslintrc.json",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
];

const BLOCKED_PREFIXES = [
  ".github/", ".git/", "node_modules/",
  ".next/", "dist/", "build/", "out/", ".vercel/",
];

// ─── Provider Detection ───────────────────────────────────────────────────────

function detectProvider(model) {
  const m = model.toLowerCase();
  if (m.startsWith("claude-"))           return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt-")) return "openai";
  if (m.startsWith("gemini-"))           return "gemini";
  if (m.startsWith("ollama:"))           return "ollama";
  // Azure OpenAI: detected by presence of AZURE_OPENAI_ENDPOINT
  if (process.env.AZURE_OPENAI_ENDPOINT) return "azure";
  fatal(`Cannot detect provider for model "${model}". Prefix with claude-, gpt-, gemini-, or ollama:.`);
}

// ─── Provider Clients ─────────────────────────────────────────────────────────

async function callAnthropic(model, systemPrompt, userPrompt) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) fatal("ANTHROPIC_API_KEY is not set.");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function callOpenAI(model, systemPrompt, userPrompt) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) fatal("OPENAI_API_KEY is not set.");

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8096,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return response.choices?.[0]?.message?.content || "";
}

async function callAzureOpenAI(model, systemPrompt, userPrompt) {
  const apiKey    = (process.env.AZURE_OPENAI_API_KEY || "").trim();
  const endpoint  = (process.env.AZURE_OPENAI_ENDPOINT || "").trim();
  const apiVersion = (process.env.AZURE_OPENAI_API_VERSION || "2024-02-01").trim();

  if (!apiKey)   fatal("AZURE_OPENAI_API_KEY is not set.");
  if (!endpoint) fatal("AZURE_OPENAI_ENDPOINT is not set.");

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: `${endpoint}/openai/deployments/${model}`,
    defaultQuery: { "api-version": apiVersion },
    defaultHeaders: { "api-key": apiKey },
  });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8096,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return response.choices?.[0]?.message?.content || "";
}

async function callGemini(model, systemPrompt, userPrompt) {
  const apiKey = (process.env.GOOGLE_API_KEY || "").trim();
  if (!apiKey) fatal("GOOGLE_API_KEY is not set.");

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
  });

  const result = await geminiModel.generateContent(userPrompt);
  return result.response.text();
}

async function callOllama(model, systemPrompt, userPrompt) {
  // model format: "ollama:modelname" e.g. "ollama:llama3"
  const ollamaModel = model.replace(/^ollama:/i, "");
  const host = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");

  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    fatal(`Ollama request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data?.message?.content || "";
}

// Unified call — provider routing
async function callModel(provider, model, systemPrompt, userPrompt) {
  switch (provider) {
    case "anthropic": return callAnthropic(model, systemPrompt, userPrompt);
    case "openai":    return callOpenAI(model, systemPrompt, userPrompt);
    case "azure":     return callAzureOpenAI(model, systemPrompt, userPrompt);
    case "gemini":    return callGemini(model, systemPrompt, userPrompt);
    case "ollama":    return callOllama(model, systemPrompt, userPrompt);
    default: fatal(`Unknown provider: ${provider}`);
  }
}

// ─── File Helpers ─────────────────────────────────────────────────────────────

function fatal(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function readFileSafe(relPath) {
  const fullPath = path.join(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) return "";
  try { return fs.readFileSync(fullPath, "utf8"); } catch { return ""; }
}

function isIgnoredPath(relPath) {
  const parts = relPath.split(path.sep);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  const ext = path.extname(relPath).toLowerCase();
  return IGNORE_FILE_EXTS.has(ext);
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
  const raw = task.toLowerCase().replace(/[`"'(),:;]+/g, " ").split(/\s+/).filter(Boolean);
  const keywords = new Set();
  for (const t of raw) { if (t.length >= 3) keywords.add(t); }
  return [...keywords];
}

function scoreFile(relPath, keywords) {
  const lower = relPath.toLowerCase();
  let score = 0;
  const ext = path.extname(lower);
  if ([".ts",".tsx",".js",".jsx",".mjs",".cjs",".md",".mdx",".json",".css",".scss"].includes(ext)) score += 3;
  if (/\/(app|src|pages|components|lib|utils|services)\//.test(lower)) score += 2;
  for (const k of keywords) { if (lower.includes(k)) score += 5; }
  return score;
}

function clampToRepo(relPath) {
  const normalized = relPath.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  if (normalized.startsWith("/") || normalized.startsWith("..") || normalized.includes("/..")) return null;
  return normalized;
}

function parsePatches(aiText) {
  const blocks = [];
  const regex = /@@FILE:([^\n@]+)@@([\s\S]*?)@@END_FILE@@/g;
  let match;
  while ((match = regex.exec(aiText)) !== null) {
    blocks.push({ filePath: match[1].trim(), content: match[2].replace(/^\n/, "") });
  }
  return blocks;
}

function buildContext(allFiles, task) {
  const keywords = tokenizeTask(task);

  const always = ALWAYS_CONTEXT_CANDIDATES.filter((p) => allFiles.includes(p));

  const explicit = [];
  const fileMentionRe = /([\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss))/gi;
  let m;
  while ((m = fileMentionRe.exec(task)) !== null) {
    const mentioned = m[1];
    if (allFiles.includes(mentioned) && !explicit.includes(mentioned)) explicit.push(mentioned);
  }

  const ranked = allFiles
    .filter((f) => !always.includes(f) && !explicit.includes(f))
    .map((f) => ({ f, s: scoreFile(f, keywords) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, MAX_FILES - always.length - explicit.length))
    .map((x) => x.f);

  const selected = [...new Set([...always, ...explicit, ...ranked])].slice(0, MAX_FILES);

  let used = 0;
  const chunks = [];

  const treeChunk = `\n// REPO_FILE_TREE\n${allFiles.slice(0, 1500).join("\n")}\n`;
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

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are an expert software engineer working on a production codebase.

You will receive:
- A TASK description
- A repo file tree and selected file contents for context
- A SOURCE_OF_TRUTH.md or MEMORY.md if present — read this FIRST and treat it as non-negotiable rules

Your job:
- Make the smallest correct set of changes to implement the task
- ALWAYS check SOURCE_OF_TRUTH.md or MEMORY.md first — never regress what they define as non-negotiable
- Output ONLY patches in this exact format (no explanation, no markdown fences, no extra text):

@@FILE:relative/path/to/file.ext@@
<FULL file contents here>
@@END_FILE@@

Rules:
- Output FULL file contents for every changed or created file (no diffs, no partial files)
- Only include files that actually need to change
- Never write outside the repo root (no absolute paths, no ../ traversal)
- Do not delete files unless explicitly asked — prefer additive changes
- Preserve existing behaviour unless the task requires changes
- Keep all imports/exports valid and the project compiling
- If SOURCE_OF_TRUTH.md defines a conversion flow, SEO structure, or API contract — do not break it
`.trim();

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) fatal('Usage: node scripts/ai-dev.mjs "Describe your change here"');

  const provider = detectProvider(AI_DEV_MODEL);

  const root = process.cwd();
  const allFiles = walkRepo(root).filter((p) => !p.endsWith("/") && !isIgnoredPath(p));
  if (!allFiles.length) fatal("No files found. Are you in the target repo directory?");

  const contextSnippets = buildContext(allFiles, task);

  const userPrompt = `TASK:\n${task}\n\nREPO CONTEXT:\n${contextSnippets}`;

  console.log(`\n🤖 AI Dev Runner — Multi-Model Edition`);
  console.log(`   Provider : ${provider}`);
  console.log(`   Model    : ${AI_DEV_MODEL}`);
  console.log(`   Repo     : ${root}`);
  console.log(`   Task     : ${task}\n`);

  const aiText = await callModel(provider, AI_DEV_MODEL, SYSTEM_PROMPT, userPrompt);

  if (!aiText) {
    console.error("AI response was empty.");
    process.exit(1);
  }

  const patches = parsePatches(aiText);
  if (!patches.length) {
    console.error("\n❌ No @@FILE blocks found. Raw response:\n");
    console.error(aiText);
    process.exit(1);
  }

  let applied = 0;
  for (const patch of patches) {
    const safeRel = clampToRepo(patch.filePath);

    if (!safeRel) {
      console.warn(`⚠️  Unsafe path skipped: ${patch.filePath}`);
      continue;
    }

    if (BLOCKED_PREFIXES.some((p) => safeRel.startsWith(p))) {
      console.warn(`⛔ Blocked write to protected path: ${safeRel}`);
      continue;
    }

    const fullPath = path.join(root, safeRel);
    const dirName  = path.dirname(fullPath);

    const cleanContent = patch.content
      .replace(/^@@FILE:[^\n]*@@\s*/gm, "")
      .replace(/^@@END_FILE@@\s*/gm,   "");

    if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
    fs.writeFileSync(fullPath, cleanContent, "utf8");
    console.log(`✅ Written: ${safeRel}`);
    applied++;
  }

  if (!applied) fatal("No patches applied — all paths were blocked or unsafe.");

  console.log(`\n✨ Done. ${applied} file(s) updated. Build gate will validate before PR.\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
