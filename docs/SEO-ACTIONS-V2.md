# SEO Actions v2

GitHub Actions is the orchestration layer for governed SEO implementation tasks. ChatGPT owns strategy, evidence synthesis and task authorization. Codex implements. Deterministic checks decide whether the candidate is mechanically acceptable.

## Cost and authentication

Normal implementation jobs use the existing ChatGPT subscription through a locally authenticated Codex CLI on an isolated self-hosted runner. `OPENAI_API_KEY` is not used and API billing is not permitted. If included Codex usage is exhausted, jobs wait for the subscription allowance to reset.

## Runner boundary

The self-hosted runner must not run in the credential-heavy `dev` environment. Use a dedicated container or OS user whose home contains only the Codex ChatGPT login and runner files. Do not expose GSC, GA4, DataForSEO, Serper, Telegram or other business credentials to the runner.

The Codex process itself is launched with a scrubbed environment so GitHub runtime tokens and other workflow variables are not inherited by the model process.

## Required task files

Each implementation task has:
- a human brief: `docs/seo/tasks/<TASK>.md`
- a machine manifest: `docs/seo/tasks/<TASK>.json`

The manifest must be committed before dispatch and must state `AUTHORIZED`, `authorized_by: Joe`, `billing: chatgpt_subscription`, the exact repository, allowed paths, prompt file, optional model/effort, observation-window state, and optional Four Stars configuration.

## Required gates

1. Observation window is eligible, unless a documented critical-defect override is true.
2. Codex runs in workspace-write sandbox on the isolated runner and receives no API key.
3. Trusted governance scripts are copied outside the writable worktree before Codex starts.
4. Scope check rejects every changed path outside `allowed_paths`; `.github/` and `scripts/seo-governance/` are always blocked.
5. `npm run build` must pass.
6. Page tasks with Four Stars enabled compare live production against the local candidate and reject an unauthorized alignment regression.
7. Scope is checked again after deterministic QA.
8. Output is a branch + draft PR only. No auto-merge and no direct push to main.
9. Joe reviews the Vercel preview before merge on revenue sites.

## Dispatch

Project workflows are triggered by an owner-authored issue comment containing a safe manifest path. GitHub queues the job and routes it to the repository's isolated `seo-codex` self-hosted runner. The workflow validates the manifest before Codex starts.

## Specialized SEO evidence

GSC/GA4 strategy remains in ChatGPT where connected. Paid or credentialed collectors on the VPS remain deterministic and separate; models receive sanitized evidence rather than raw credentials.
