#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root (or with sudo)."
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="/home/dev/agency/seo-controller"

if ! id dev >/dev/null 2>&1; then
  echo "Missing dev user"
  exit 1
fi

install -d -o dev -g dev -m 0755 /home/dev/agency /home/dev/agency/projects "$DEST"
install -o dev -g dev -m 0755 "$SRC_DIR/controller.py" "$DEST/controller.py"
install -o dev -g dev -m 0644 "$SRC_DIR/projects.json" "$DEST/projects.json"

# Ensure stable project checkouts exist. Do not alter an existing checkout.
if [[ ! -d /home/dev/agency/projects/brevardsepticservices-codex/.git ]]; then
  echo "Brevard stable checkout is missing. Clone/authentication will be handled by the controller on first authorized run."
fi
if [[ ! -d /home/dev/agency/projects/huntsvillesepticpros-codex/.git ]]; then
  echo "Huntsville stable checkout is missing. Clone/authentication will be handled by the controller on first authorized run."
fi

# Preflight required local dependencies without printing credentials.
for cmd in git python3 codex; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
done

for f in /home/dev/.config/hsp-handoff/env /home/dev/.config/hsp-handoff/brevard.env; do
  if [[ ! -r "$f" ]]; then
    echo "Missing or unreadable required config: $f"
    exit 1
  fi
done

install -o root -g root -m 0644 "$SRC_DIR/seo-controller.service" /etc/systemd/system/seo-controller.service
install -o root -g root -m 0644 "$SRC_DIR/seo-controller.timer" /etc/systemd/system/seo-controller.timer

systemctl daemon-reload
systemctl enable --now seo-controller.timer

# One dry poll: with queues IDLE this should make no changes.
systemctl start seo-controller.service

printf '\n== SEO controller status ==\n'
systemctl --no-pager --full status seo-controller.timer || true
printf '\n== Last controller run ==\n'
journalctl -u seo-controller.service -n 25 --no-pager || true
printf '\nInstalled. Routine execution no longer depends on an SSH/tmux session.\n'
