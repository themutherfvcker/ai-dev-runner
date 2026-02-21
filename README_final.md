# AI Dev Runner — Multi-Model Edition

AI-powered code changes via GitHub Actions. No local install required.

Supports **Anthropic Claude**, **OpenAI (incl. Azure)**, **Google Gemini**, and **Ollama** (local/self-hosted).

---

## How it works

1. You trigger the workflow from GitHub Actions UI with a plain-English task description
2. The runner walks your repo, builds a relevant context window, and injects `SOURCE_OF_TRUTH.md` or `MEMORY.md` if present
3. The AI makes changes and returns full file replacements in a structured format
4. A build gate validates the changes compile cleanly
5. A PR is opened for your review (or changes are pushed direct to main if you prefer)

---

## Setup

### 1. Add this repo as a dependency in your workflow

```yaml
- uses: actions/checkout@v4
  with:
    repository: themutherfvcker/ai-dev-runner
    path: runner
```

### 2. Add the workflow file to your repo

Copy `ai-dev.yml` to `.github/workflows/ai-dev.yml` in your target repo.

### 3. Add API keys as GitHub Secrets

Only add the keys for the providers you intend to use:

| Secret | Provider |
|--------|----------|
| `ANTHROPIC_API_KEY` | Claude (claude-*) |
| `OPENAI_API_KEY` | OpenAI (gpt-*, o1, o3) |
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` | Azure OpenAI |
| `GOOGLE_API_KEY` | Gemini (gemini-*) |
| `OLLAMA_HOST` | Ollama self-hosted (default: http://localhost:11434) |

---

## Supported Models

### Anthropic Claude
| Model | Best for |
|-------|----------|
| `claude-opus-4-6` | Complex refactors, multi-file architectural changes |
| `claude-sonnet-4-6` | Most tasks — fast, smart, good value ✅ Default |
| `claude-haiku-4-5-20251001` | Simple targeted fixes, cheapest option |

### OpenAI
| Model | Best for |
|-------|----------|
| `gpt-5.2` | Flagship — best for complex coding tasks and refactors |
| `gpt-5.2-chat-latest` | Instant variant — faster, cheaper, good all-rounder |
| `gpt-5.1` | Previous generation — solid fallback, good value |
| `gpt-4o` | Older but cheapest OpenAI option for very simple fixes |

> **Note:** `gpt-5.2` and `gpt-5.2-chat-latest` use the Responses API. The runner handles both Chat Completions and Responses API formats automatically based on the model string.

### Google Gemini
| Model | Best for |
|-------|----------|
| `gemini-2.0-flash` | Fast Gemini option |
| `gemini-2.5-pro-preview-03-25` | Most capable Gemini |

### Ollama (local/self-hosted)
| Model | Best for |
|-------|----------|
| `ollama:llama3` | Privacy-sensitive codebases, no data leaves your infra |
| `ollama:codestral` | Code-specific tasks |
| `ollama:deepseek-coder` | Code-specific, strong on logic |

---

## Context Injection

The runner automatically includes these files in every prompt (if present):

- `docs/SOURCE_OF_TRUTH.md` — architectural rules the AI must never break
- `MEMORY.md` / `docs/MEMORY.md` — project memory and decisions
- `package.json`, `tsconfig.json`, `tailwind.config.*`, etc.
- Any files explicitly mentioned in your task description
- Top-ranked files by keyword relevance to the task

**Tip:** Keep a `SOURCE_OF_TRUTH.md` in your repo documenting your non-negotiables. The AI reads this before touching anything.

---

## Security

The AI is **never** allowed to write to:
- `.github/` — protects your workflows from self-modification
- `node_modules/`, `.next/`, `dist/`, `build/`, `.vercel/`
- Any path with `../` traversal

---

## Environment Variables (advanced)

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_DEV_MODEL` | `claude-sonnet-4-6` | Model to use |
| `AI_DEV_MAX_CONTEXT_CHARS` | `180000` | Max chars in context window |
| `AI_DEV_MAX_FILES` | `35` | Max files included in context |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `AZURE_OPENAI_API_VERSION` | `2024-02-01` | Azure API version |

---

## Output Format

The AI must return changes in this exact format (enforced by the system prompt):

```
@@FILE:relative/path/to/file.ext@@
<full file contents>
@@END_FILE@@
```

Full file overwrites only — no diffs. This matches the requirement in `SOURCE_OF_TRUTH.md` for drop-in file replacements.

---

## Tips

- **Be specific in your task description.** "Add Hillsborough County GIS connector to app/lib/gisConnectors.ts" works better than "add a county."
- **Mention file paths** in your task if you know which files need changing — they get priority in the context window.
- **No automatic throttling** — the runner always uses exactly the model you select. Pick claude-opus-4-6 or gpt-5.2 for complex refactors, claude-sonnet-4-6 or gpt-5.2-chat-latest for most tasks, claude-haiku or gpt-4o for trivial fixes. You control cost via the dropdown.
- **Ollama** is useful for sensitive codebases where you don't want code leaving your infrastructure.
- The **PR flow** (default) is strongly recommended — always review AI changes before merging to production.
