#!/usr/bin/env python3
"""One-shot SEO controller.

Polls narrow per-project GitHub queue issues, claims explicitly authorized work,
then either runs an allowlisted read-only repo command or launches a fresh Codex
worker for a governed write task. Intended to be called by a systemd timer.

Secrets are read from existing local env files and are never placed in prompts,
queue issues, logs, or result comments.
"""

from __future__ import annotations

import base64
import datetime as dt
import fnmatch
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from typing import Any

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("SEO_CONTROLLER_CONFIG", ROOT / "projects.json"))
LOCK_PATH = Path("/tmp/seo-controller.lock")
JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.S | re.I)
ALLOWED_CHECKS = {"npm run build", "npm run lint", "npm test"}
MAX_RESULT_CHARS = 30000


class ControllerError(RuntimeError):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None,
        timeout: int = 1800, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "command failed")[-4000:]
        raise ControllerError(f"command failed ({proc.returncode}): {cmd[0]}: {detail}")
    return proc


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise ControllerError(f"missing env file: {path}")
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        out[key.strip()] = value
    return out


def token_for(project: dict[str, Any]) -> str:
    env = parse_env_file(Path(project["token_env_file"]))
    token = env.get("HSP_HANDOFF_TOKEN") or env.get("GITHUB_TOKEN") or env.get("GH_TOKEN")
    if not token:
        raise ControllerError("GitHub token not found in configured env file")
    return token


def gh(repo: str, token: str, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    url = f"https://api.github.com/repos/{repo}{path}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[-2000:]
        raise ControllerError(f"GitHub API {method} {path} failed: HTTP {exc.code}: {body}") from None


def parse_queue(body: str) -> dict[str, Any]:
    match = JSON_BLOCK_RE.search(body or "")
    if not match:
        raise ControllerError("queue issue has no fenced JSON state block")
    try:
        state = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise ControllerError(f"invalid queue JSON: {exc}") from None
    if state.get("schema") != "seo-controller/v1":
        raise ControllerError("unsupported queue schema")
    return state


def render_queue(body: str, state: dict[str, Any]) -> str:
    block = "```json\n" + json.dumps(state, indent=2, sort_keys=False) + "\n```"
    if not JSON_BLOCK_RE.search(body or ""):
        raise ControllerError("cannot update queue: JSON block missing")
    return JSON_BLOCK_RE.sub(block, body, count=1)


def fetch_issue(project: dict[str, Any], token: str) -> tuple[str, dict[str, Any]]:
    issue = gh(project["repo"], token, "GET", f"/issues/{project['queue_issue']}")
    body = issue.get("body") or ""
    return body, parse_queue(body)


def update_queue(project: dict[str, Any], token: str, body: str, state: dict[str, Any]) -> str:
    new_body = render_queue(body, state)
    gh(project["repo"], token, "PATCH", f"/issues/{project['queue_issue']}", {"body": new_body})
    return new_body


def comment(project: dict[str, Any], token: str, text: str) -> None:
    gh(project["repo"], token, "POST", f"/issues/{project['queue_issue']}/comments", {"body": text[:60000]})


def ensure_checkout(project: dict[str, Any], token: str) -> Path:
    checkout = Path(project["checkout"])
    if not (checkout / ".git").exists():
        checkout.parent.mkdir(parents=True, exist_ok=True)
        clone_with_token(project["repo"], checkout, token)
    return checkout


def askpass_env(token: str) -> tuple[dict[str, str], tempfile.TemporaryDirectory[str]]:
    tmp = tempfile.TemporaryDirectory(prefix="seo-controller-askpass-")
    script = Path(tmp.name) / "askpass.sh"
    script.write_text(
        "#!/bin/sh\ncase \"$1\" in\n  *Username*) echo x-access-token ;;\n  *Password*) printf '%s\\n' \"$SEO_CONTROLLER_GH_TOKEN\" ;;\n  *) exit 1 ;;\nesac\n",
        encoding="utf-8",
    )
    script.chmod(0o700)
    env = os.environ.copy()
    env.update({
        "GIT_ASKPASS": str(script),
        "GIT_TERMINAL_PROMPT": "0",
        "SEO_CONTROLLER_GH_TOKEN": token,
    })
    return env, tmp


def clone_with_token(repo: str, checkout: Path, token: str) -> None:
    env, tmp = askpass_env(token)
    try:
        run(["git", "clone", f"https://github.com/{repo}.git", str(checkout)], env=env, timeout=600)
    finally:
        tmp.cleanup()


def clean_and_fetch(checkout: Path, token: str) -> None:
    dirty = run(["git", "status", "--porcelain"], cwd=checkout).stdout.strip()
    if dirty:
        raise ControllerError("checkout is dirty; refusing to run")
    env, tmp = askpass_env(token)
    try:
        run(["git", "fetch", "--prune", "origin"], cwd=checkout, env=env, timeout=300)
    finally:
        tmp.cleanup()


def resolve_remote_ref(checkout: Path, ref: str) -> str:
    candidates = [f"origin/{ref}", ref]
    for candidate in candidates:
        if run(["git", "rev-parse", "--verify", candidate], cwd=checkout, check=False).returncode == 0:
            return candidate
    raise ControllerError(f"base ref not found: {ref}")


def validate_common(project_name: str, project: dict[str, Any], state: dict[str, Any]) -> None:
    task_id = state.get("task_id")
    if not isinstance(task_id, str) or not task_id.startswith(project["task_prefix"]):
        raise ControllerError("task id missing or does not match project prefix")
    if state.get("authorized_by") != "Joe":
        raise ControllerError("task is not explicitly authorized_by Joe")
    if state.get("project") != project_name:
        raise ControllerError("queue project mismatch")
    if state.get("status") != "READY_FOR_CODEX":
        raise ControllerError("task is not READY_FOR_CODEX")
    task_file = state.get("task_file")
    if not isinstance(task_file, str) or task_file.startswith("/") or ".." in Path(task_file).parts:
        raise ControllerError("invalid task_file")


def prepare_ref(checkout: Path, state: dict[str, Any]) -> str:
    base_ref = state.get("base_ref") or "main"
    return resolve_remote_ref(checkout, base_ref)


def validate_readonly_entrypoint(entrypoint: Any) -> list[str]:
    if not isinstance(entrypoint, list) or len(entrypoint) < 2 or not all(isinstance(x, str) for x in entrypoint):
        raise ControllerError("read_only_command requires entrypoint as argv array")
    if entrypoint[0] not in {"bash", "python3"}:
        raise ControllerError("read-only entrypoint must use bash or python3")
    script = Path(entrypoint[1])
    if script.is_absolute() or ".." in script.parts or not script.as_posix().startswith("scripts/"):
        raise ControllerError("read-only script must be a relative path under scripts/")
    return entrypoint


def run_readonly(checkout: Path, state: dict[str, Any], remote_ref: str) -> str:
    if state.get("production_edits") is not False:
        raise ControllerError("read_only_command requires production_edits=false")
    entrypoint = validate_readonly_entrypoint(state.get("entrypoint"))
    run(["git", "switch", "--detach", remote_ref], cwd=checkout)
    script_path = checkout / entrypoint[1]
    if not script_path.is_file():
        raise ControllerError(f"entrypoint not found at selected ref: {entrypoint[1]}")
    proc = run(entrypoint, cwd=checkout, timeout=3600, check=False)
    output = (proc.stdout or "") + ("\nSTDERR:\n" + proc.stderr if proc.stderr else "")
    if proc.returncode != 0:
        raise ControllerError(f"read-only task failed ({proc.returncode}): {output[-5000:]}")
    dirty = run(["git", "status", "--porcelain"], cwd=checkout).stdout.strip()
    if dirty:
        raise ControllerError("read-only task modified tracked/untracked checkout state")
    return output[-MAX_RESULT_CHARS:]


def path_allowed(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def run_write(checkout: Path, project: dict[str, Any], token: str, state: dict[str, Any], remote_ref: str) -> tuple[str, str]:
    if state.get("production_edits") is not True:
        raise ControllerError("codex_write requires production_edits=true")
    allowed = state.get("allowed_paths")
    if not isinstance(allowed, list) or not allowed or not all(isinstance(x, str) and x for x in allowed):
        raise ControllerError("codex_write requires non-empty allowed_paths")
    checks = state.get("checks") or ["npm run build"]
    if not isinstance(checks, list) or any(c not in ALLOWED_CHECKS for c in checks):
        raise ControllerError(f"unsupported check; allowed: {sorted(ALLOWED_CHECKS)}")

    task_id = state["task_id"]
    task_file = state["task_file"]
    branch = f"codex/{task_id.lower()}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    run(["git", "switch", "-C", branch, remote_ref], cwd=checkout)

    prompt = f"""Execute governed task {task_id} from {task_file}.
Read AGENTS.md if present, then the current-state document referenced there, then only task-relevant evidence.
You may modify ONLY paths matching: {json.dumps(allowed)}.
Do not commit, push, create a PR, deploy, access secrets, source shared env files, or make paid API calls unless the task contract explicitly authorizes them.
Make the required code/content changes in the working tree, run only local reasoning/tooling available inside the sandbox, and finish with a concise implementation summary. The controller will validate paths, run checks, commit, push and open the PR outside your model sandbox.
"""
    proc = run(
        ["codex", "exec", "--sandbox", "workspace-write", "--ephemeral", prompt],
        cwd=checkout,
        timeout=7200,
        check=False,
    )
    if proc.returncode != 0:
        raise ControllerError(f"Codex failed ({proc.returncode}): {(proc.stderr or proc.stdout)[-5000:]}")

    changed = run(["git", "status", "--porcelain"], cwd=checkout).stdout.splitlines()
    changed_paths: list[str] = []
    for line in changed:
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        changed_paths.append(path)
    if not changed_paths:
        raise ControllerError("Codex produced no file changes")
    forbidden = [p for p in changed_paths if not path_allowed(p, allowed)]
    if forbidden:
        raise ControllerError(f"Codex changed paths outside allowlist: {forbidden}")

    for check_cmd in checks:
        run(shlex.split(check_cmd), cwd=checkout, timeout=1800)

    run(["git", "add", "--all"], cwd=checkout)
    run(["git", "commit", "-m", f"{task_id}: Codex implementation"], cwd=checkout)
    commit_sha = run(["git", "rev-parse", "HEAD"], cwd=checkout).stdout.strip()

    env, tmp = askpass_env(token)
    try:
        run(["git", "push", "origin", f"HEAD:{branch}"], cwd=checkout, env=env, timeout=600)
    finally:
        tmp.cleanup()

    pr = gh(project["repo"], token, "POST", "/pulls", {
        "title": f"{task_id}: Codex implementation",
        "head": branch,
        "base": state.get("base_ref") or "main",
        "body": (
            f"Automated by SEO controller for governed task `{task_id}`.\n\n"
            f"Allowed paths: `{', '.join(allowed)}`\n\n"
            f"Checks: `{', '.join(checks)}`\n\n"
            "Review required. This controller never auto-merges production work."
        ),
        "draft": True,
    })
    summary = (proc.stdout or "")[-8000:]
    return pr.get("html_url", ""), f"commit {commit_sha}\nchanged: {changed_paths}\n\nCodex summary:\n{summary}"


def process_project(name: str, project: dict[str, Any]) -> None:
    token = token_for(project)
    body, state = fetch_issue(project, token)
    if state.get("status") != "READY_FOR_CODEX":
        return

    validate_common(name, project, state)
    run_id = f"{state['task_id']}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    state.update({"status": "RUNNING", "run_id": run_id, "started_at": now_iso(), "result": None})
    body = update_queue(project, token, body, state)
    comment(project, token, f"`{run_id}` claimed by shared SEO controller. Mode: `{state.get('mode')}`.")

    try:
        checkout = ensure_checkout(project, token)
        clean_and_fetch(checkout, token)
        remote_ref = prepare_ref(checkout, state)
        mode = state.get("mode")
        if mode == "read_only_command":
            result = run_readonly(checkout, state, remote_ref)
            state.update({
                "status": "READY_FOR_REVIEW",
                "finished_at": now_iso(),
                "result": {"kind": "read_only", "run_id": run_id},
            })
            update_queue(project, token, body, state)
            comment(project, token, f"## {state['task_id']} — READY_FOR_REVIEW\n\nRun: `{run_id}`\n\n```text\n{result}\n```")
        elif mode == "codex_write":
            pr_url, result = run_write(checkout, project, token, state, remote_ref)
            state.update({
                "status": "READY_FOR_REVIEW",
                "finished_at": now_iso(),
                "result": {"kind": "pull_request", "run_id": run_id, "pr_url": pr_url},
            })
            update_queue(project, token, body, state)
            comment(project, token, f"## {state['task_id']} — READY_FOR_REVIEW\n\nRun: `{run_id}`\n\nPR: {pr_url}\n\n```text\n{result[:12000]}\n```")
        else:
            raise ControllerError(f"unsupported mode: {mode}")
    except Exception as exc:
        state.update({
            "status": "FAILED",
            "finished_at": now_iso(),
            "result": {"kind": "error", "run_id": run_id, "message": str(exc)[:1500]},
        })
        try:
            update_queue(project, token, body, state)
            comment(project, token, f"## {state['task_id']} — FAILED\n\nRun: `{run_id}`\n\n`{str(exc)[:5000]}`")
        except Exception:
            pass
        raise


def main() -> int:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    LOCK_PATH.touch(exist_ok=True)
    with LOCK_PATH.open("r+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        failures = 0
        for name, project in config.get("projects", {}).items():
            try:
                process_project(name, project)
            except Exception as exc:
                failures += 1
                print(f"[{name}] ERROR: {exc}", file=sys.stderr)
        return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
