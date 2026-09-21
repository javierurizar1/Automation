#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'This installer supports Linux systemd user services only.' >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  printf '%s\n' 'systemctl is required.' >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
app_root="$(cd -- "$script_dir/.." && pwd -P)"
node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"
if [[ -z "$node_bin" || -z "$npm_bin" ]]; then
  printf '%s\n' 'Install Node.js and npm, then rerun this installer.' >&2
  exit 1
fi
if [[ ! -f "$app_root/config.json" ]]; then
  printf '%s\n' 'Create the private config.json before installing the controller service.' >&2
  exit 1
fi
node_dir="$(dirname -- "$node_bin")"
if [[ "$node_dir" =~ [^A-Za-z0-9_./+-] || "$app_root" =~ [[:space:]%] ]]; then
  printf '%s\n' 'The app or Node.js path contains whitespace or unsupported systemd characters.' >&2
  exit 1
fi
if [[ ! -d "$app_root/node_modules/playwright-core" ]]; then
  (cd -- "$app_root" && "$npm_bin" ci)
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d -m 0755 "$unit_dir"
python3 - "$app_root" "$node_dir" "$unit_dir" <<'PY'
from pathlib import Path
import sys

app_root, node_dir, unit_dir = sys.argv[1:]
source = Path(app_root) / 'systemd' / 'user'
target = Path(unit_dir)
root_value = app_root
for name in (
    'r433-audit-controller.service',
    'r433-audit-dashboard.service',
    'r433-audit-watchdog.service',
    'r433-audit-watchdog.timer',
):
    content = (source / name).read_text(encoding='utf-8')
    content = content.replace('@APP_ROOT@', root_value).replace('@NODE_BIN_DIR@', node_dir)
    (target / name).write_text(content, encoding='utf-8')
PY

install -d -m 0700 "$app_root/data" "$app_root/logs"
systemctl --user daemon-reload
systemctl --user enable r433-audit-controller.service r433-audit-dashboard.service r433-audit-watchdog.timer
systemctl --user start r433-audit-controller.service r433-audit-dashboard.service r433-audit-watchdog.timer
printf 'Enabled controller, dashboard, and watchdog timer for %s\n' "$app_root"
printf '%s\n' 'Dashboard: http://127.0.0.1:9350/'
