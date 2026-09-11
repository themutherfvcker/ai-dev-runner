# Shared SEO Codex Execution — Current Architecture

> Durable execution-state document for Brevard Septic Services and Huntsville Septic Pros.
>
> Snapshot: 2026-09-12

## Status

The execution migration is complete enough for normal governed SEO implementation. Stop expanding infrastructure unless a real task exposes a concrete blocker.

## Final operating loop

```text
Joe -> ChatGPT -> governed repo task -> GitHub Actions
     -> isolated self-hosted VPS runner -> fresh Codex
     -> scope/build/Four Stars gates -> governed branch
     -> ChatGPT creates/reviews draft PR -> Joe merge -> Vercel
     -> observation window -> GSC/GA4/SERP measurement
```

ChatGPT is the strategy/management/review layer. Codex is the bounded implementation worker. GitHub/repo state is durable memory. The VPS is an execution/tool host, not the project brain.

## Cost/authentication policy

- Codex on the VPS is authenticated with Joe's existing ChatGPT subscription.
- `OPENAI_API_KEY` is forbidden in this workflow.
- No automatic paid API fallback is permitted.
- If included Codex allowance is exhausted, work waits for the subscription allowance to reset.

## Runner/security boundary

- GitHub Actions runners execute as isolated Linux user `seo-runner`, not credential-heavy `dev`.
- Separate repository runners exist for Brevard and Huntsville.
- `seo-runner` cannot read `/home/dev/.config/seo-geo.env` or `/home/dev/.config/gsc-sa.json`.
- Codex receives a scrubbed environment and workspace-bounded instructions.
- Trusted governance scripts are copied outside the writable worktree before Codex starts.
- Task scope is enforced mechanically before and after build/QA.
- Codex does not commit, push, deploy, or access external apps/connectors; the workflow handles the governed branch.

## Dispatch and review

A task is not authorized merely because a file exists. Joe/ChatGPT must explicitly authorize it and the manifest must pass governance validation.

Repository GitHub settings currently do not permit GitHub Actions to create pull requests. Therefore the final handoff is intentionally:

1. Actions validates, runs Codex, checks scope/build/Four Stars as applicable, commits and pushes a governed branch.
2. Actions posts `READY_FOR_REVIEW_BRANCH` to the repository dispatch issue.
3. ChatGPT uses the GitHub connector to create and review the draft PR.
4. Joe remains the final merge authority for production-site changes.

## Independent gates

Every production implementation should use the applicable deterministic checks:

- build/type/lint gate;
- changed-file allowlist/scope gate;
- Four Stars regression/alignment gate where the task uses Four Stars;
- Vercel preview inspection before merge for meaningful page changes;
- observation-window rules after shipping.

Four Stars validates the chosen SEO spine; it does not choose keywords, ownership, or strategy.

## Proof runs completed

### Brevard — BSS-900

- isolated self-hosted runner used;
- ChatGPT subscription authentication confirmed by runner;
- Codex created exactly one authorized documentation proof file;
- scope gate passed;
- production Next.js build passed;
- governed branch pushed;
- ChatGPT opened draft PR #9;
- no production SEO/application change.

### Huntsville — HSP-900

- isolated self-hosted runner used;
- ChatGPT subscription authentication confirmed by runner;
- Codex created exactly one authorized documentation proof file;
- scope gate passed;
- production Next.js build passed;
- governed branch reported successfully;
- ChatGPT opened draft PR #5;
- no production SEO/application change.

## Operational rule

Do not return to manual SSH/copy-paste for routine SEO execution. Remote Desktop Commander is an admin/bootstrap fallback, not the normal task path.

Do not build another controller, queue, Telegram layer, or automation subsystem unless a real recurring problem demonstrates that GitHub Actions + ChatGPT + Codex cannot handle it.

## Continuity rule

Long ChatGPT conversations are disposable. Durable changes in strategy, protection state, experiment status, execution architecture, or task authorization must be written back to the relevant repo current-state/task documents before a conversation is retired.
