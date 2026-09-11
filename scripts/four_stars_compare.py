#!/usr/bin/env python3
import argparse, json, subprocess
from pathlib import Path


def score(cli: Path, url: str, keyword: str) -> dict:
    out = subprocess.check_output([
        "python3", str(cli), "--url", url, "--keyword", keyword, "--json"
    ], text=True)
    return json.loads(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool-dir", required=True)
    ap.add_argument("--baseline-url", required=True)
    ap.add_argument("--candidate-url", required=True)
    ap.add_argument("--keyword", required=True)
    ap.add_argument("--min-delta", type=float, default=0.0)
    ap.add_argument("--output", default="four-stars-comparison.json")
    args = ap.parse_args()

    cli = Path(args.tool_dir) / "cli.py"
    before = score(cli, args.baseline_url, args.keyword)
    after = score(cli, args.candidate_url, args.keyword)
    delta = round(after["total"] - before["total"], 1)
    result = {
        "keyword": args.keyword,
        "baseline": {"url": args.baseline_url, "score": before["total"], "grade": before["grade"]},
        "candidate": {"url": args.candidate_url, "score": after["total"], "grade": after["grade"]},
        "delta": delta,
        "min_delta": args.min_delta,
    }
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    if delta < args.min_delta:
        raise SystemExit(
            f"Four Stars regression: delta {delta} < allowed minimum {args.min_delta}"
        )
    print("PASS: Four Stars alignment gate")


if __name__ == "__main__":
    main()
