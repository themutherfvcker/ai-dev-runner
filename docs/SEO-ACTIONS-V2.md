# SEO Actions v2

GitHub Actions is the orchestration layer for governed SEO implementation tasks.
ChatGPT owns strategy, evidence synthesis and task authorization. Codex implements.
Deterministic checks decide whether the candidate is mechanically acceptable.

## Required task files

Each implementation task has:
- a human brief: `docs/seo/tasks/<TASK>.md`
- a machine manifest: `docs/seo/tasks/<TASK>.json`

The manifest must be committed before dispatch and must state `AUTHORIZED`, `authorized_by: Joe`, the exact repository, allowed paths, prompt file, model/effort, observation-window state, and optional Four Stars configuration.

## Required gates

1. Observation window is eligible, unless a documented critical-defect override is true.
2. Codex may edit the workspace only.
3. Scope check rejects any changed path outside `allowed_paths`; `.github/` is always blocked.
4. `npm run build` must pass.
5. Page tasks with Four Stars enabled compare live production against the local candidate and reject an unauthorized alignment regression.
6. Output is a branch + draft PR only. No auto-merge and no direct push to main.

## Dispatch

Project workflows are triggered by an owner-authored issue comment containing a safe manifest path. The workflow validates the manifest before Codex starts. Joe retains the final merge decision after ChatGPT review and Vercel preview inspection.
