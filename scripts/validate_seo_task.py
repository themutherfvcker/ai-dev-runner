#!/usr/bin/env python3
import argparse, json, os, re
from datetime import date
from pathlib import Path, PurePosixPath

TASK_RE = re.compile(r"^(BSS|HSP)-\d{3,}$")
ALLOWED_EFFORT = {"low", "medium", "high"}


def safe_rel(value: str) -> str:
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts or value.startswith("./"):
        raise ValueError(f"unsafe relative path: {value}")
    return value


def out(name: str, value) -> None:
    target = os.environ.get("GITHUB_OUTPUT")
    line = f"{name}={str(value).lower() if isinstance(value, bool) else value}\n"
    if target:
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(line)
    else:
        print(line, end="")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--repo", required=True)
    args = ap.parse_args()

    manifest_path = safe_rel(args.manifest)
    if not manifest_path.startswith("docs/seo/tasks/") or not manifest_path.endswith(".json"):
        raise SystemExit("manifest must be docs/seo/tasks/*.json")

    p = Path(manifest_path)
    data = json.loads(p.read_text(encoding="utf-8"))
    if data.get("schema") != "seo-task/v1":
        raise SystemExit("unsupported task schema")
    if data.get("repo") != args.repo:
        raise SystemExit("task repo does not match workflow repository")
    if data.get("status") != "AUTHORIZED" or data.get("authorized_by") != "Joe":
        raise SystemExit("task is not explicitly Joe-authorized")
    if data.get("mode") != "write":
        raise SystemExit("this workflow only accepts mode=write")
    if data.get("billing") != "chatgpt_subscription":
        raise SystemExit("billing must be chatgpt_subscription; API billing is not permitted")

    task_id = data.get("task_id", "")
    if not TASK_RE.fullmatch(task_id):
        raise SystemExit("invalid task_id")
    prompt_file = safe_rel(data.get("prompt_file", ""))
    if not Path(prompt_file).is_file():
        raise SystemExit("prompt_file does not exist")

    allowed = data.get("allowed_paths")
    if not isinstance(allowed, list) or not allowed:
        raise SystemExit("allowed_paths must be a non-empty list")
    for item in allowed:
        if not isinstance(item, str) or not item.strip():
            raise SystemExit("allowed_paths entries must be non-empty strings")
        safe_rel(item)

    eligible = data.get("next_eligible_intervention")
    override = bool(data.get("critical_defect_override", False))
    if eligible and not override:
        try:
            eligible_date = date.fromisoformat(eligible)
        except ValueError as exc:
            raise SystemExit("invalid next_eligible_intervention date") from exc
        if date.today() < eligible_date:
            raise SystemExit(f"observation window active until {eligible_date.isoformat()}")

    model = data.get("model", "")
    if model is not None and not isinstance(model, str):
        raise SystemExit("model must be a string when supplied")
    effort = data.get("effort", "medium")
    if effort not in ALLOWED_EFFORT:
        raise SystemExit(f"effort must be one of {sorted(ALLOWED_EFFORT)}")

    fs = data.get("four_stars") or {}
    enabled = bool(fs.get("enabled", False))
    if enabled:
        for key in ("production_url", "route", "keyword"):
            if not isinstance(fs.get(key), str) or not fs[key].strip():
                raise SystemExit(f"four_stars.{key} is required when enabled")

    out("task_id", task_id)
    out("prompt_file", prompt_file)
    out("model", model or "")
    out("effort", effort)
    out("four_stars_enabled", enabled)
    out("four_stars_production_url", fs.get("production_url", ""))
    out("four_stars_route", fs.get("route", ""))
    out("four_stars_keyword", fs.get("keyword", ""))
    out("four_stars_min_delta", fs.get("min_delta", 0))
    out("manifest_path", manifest_path)
    print(f"PASS: authorized subscription-backed governed task {task_id}")


if __name__ == "__main__":
    main()
