#!/usr/bin/env python3
import argparse, fnmatch, json, subprocess
from pathlib import PurePosixPath

HARD_BLOCKED = (".github/",)


def changed_files() -> list[str]:
    tracked = subprocess.check_output(["git", "diff", "--name-only", "--diff-filter=ACMRTUXB"], text=True).splitlines()
    untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard"], text=True).splitlines()
    return sorted(set(x.strip() for x in tracked + untracked if x.strip()))


def matches(path: str, rule: str) -> bool:
    if rule.endswith("/"):
        return path.startswith(rule)
    if any(ch in rule for ch in "*?["):
        return fnmatch.fnmatchcase(path, rule)
    return path == rule


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    args = ap.parse_args()
    data = json.load(open(args.manifest, encoding="utf-8"))
    allowed = data["allowed_paths"]
    changed = changed_files()
    if not changed:
        raise SystemExit("no changes produced by Codex")

    violations = []
    for path in changed:
        PurePosixPath(path)
        if path.startswith(HARD_BLOCKED):
            violations.append((path, "hard-blocked workflow path"))
            continue
        if not any(matches(path, rule) for rule in allowed):
            violations.append((path, "outside allowed_paths"))

    print("Changed files:")
    for path in changed:
        print(f"  {path}")
    if violations:
        print("SCOPE FAIL:")
        for path, reason in violations:
            print(f"  {path}: {reason}")
        raise SystemExit(2)
    print("PASS: every changed file is inside the governed scope")


if __name__ == "__main__":
    main()
