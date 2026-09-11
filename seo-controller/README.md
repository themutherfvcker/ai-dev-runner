# Shared SEO Codex Controller v1

Purpose: remove Joe from routine VPS copy/paste while keeping ChatGPT as strategy/review, GitHub as durable control/state, and fresh Codex workers as execution.

## Flow

`ChatGPT -> project Controller Queue issue -> systemd timer -> controller.py -> fresh Codex or bounded repo runner -> GitHub result/PR -> ChatGPT review -> merge -> Vercel`

The controller is a one-shot process invoked by `seo-controller.timer` every 60 seconds. It does not require an open terminal, tmux session, browser session, or persistent AI conversation.

## Initial projects

- Brevard: `themutherfvcker/brevardsepticservices`, queue Issue #6.
- Huntsville: `themutherfvcker/huntsvillesepticpros`, queue Issue #2.

Historical Issue #1 in each repo is not polled and is not placed into Codex context.

## Queue statuses

- `IDLE` — no work.
- `READY_FOR_CODEX` — Joe-authorized task waiting to be claimed.
- `RUNNING` — controller claimed the task with an idempotent run id.
- `READY_FOR_REVIEW` — result or PR available for ChatGPT/Joe review.
- `FAILED` — fail-closed result; no automatic retry.

## Modes

### `read_only_command`

Runs a bounded repo script using argv form, e.g.:

```json
{
  "mode": "read_only_command",
  "entrypoint": ["bash", "scripts/bss-012-run.sh"],
  "production_edits": false
}
```

The script must live under `scripts/`. The controller refuses success if the checkout becomes dirty.

### `codex_write`

Creates a fresh branch from the configured base ref, launches a fresh ephemeral Codex worker with `workspace-write`, validates every changed path against `allowed_paths`, runs only allowlisted checks, commits, pushes, and opens a **draft PR**. It never auto-merges.

Example dispatch fields:

```json
{
  "mode": "codex_write",
  "production_edits": true,
  "allowed_paths": ["app/services/septic-tank-repair/page.tsx"],
  "checks": ["npm run build"]
}
```

## Authorization

The controller acts only when all are true:

- queue status is `READY_FOR_CODEX`;
- `authorized_by` equals `Joe`;
- task id matches the project's prefix;
- task file is a safe relative path;
- mode-specific safety fields validate.

## Secrets

GitHub tokens are read from the existing local `~/.config/hsp-handoff/*.env` files. They are used by the deterministic controller only and are never included in Codex prompts or GitHub queue state. Project-specific analytics/API credentials remain behind repo scripts/wrappers.

## Install

One time, from a checkout of this branch/repo:

```bash
sudo bash seo-controller/install.sh
```

The installer copies controller files to `/home/dev/agency/seo-controller`, installs a system-level one-shot service + timer, enables the timer, and performs an IDLE smoke poll.

## Operations

```bash
systemctl status seo-controller.timer
systemctl status seo-controller.service
journalctl -u seo-controller.service -n 100 --no-pager
```

Routine SEO execution should not require these commands; they are admin/debug only.

## v1 safety boundaries

- no auto-merge;
- no direct write to `main` for production work;
- no arbitrary shell string from queue state;
- no paid API authorization by default;
- no full historical issue ingestion;
- no Telegram dependency;
- Claude/tmux remains untouched during migration proof.
