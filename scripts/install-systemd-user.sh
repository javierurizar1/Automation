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

browser_executable="$(
  "$node_bin" --input-type=module - "$app_root/config.json" <<'NODE'
import fs from 'node:fs';
import process from 'node:process';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String(config.browserExecutable || '').trim());
NODE
)"
if [[ -z "$browser_executable" ]]; then
  for candidate in brave-browser google-chrome chromium chromium-browser microsoft-edge; do
    if command -v "$candidate" >/dev/null 2>&1; then
      browser_executable="$(command -v "$candidate")"
      break
    fi
  done
fi
if [[ -z "$browser_executable" ]]; then
  printf '%s\n' 'A supported Chromium browser is required for the persistent source-browser service.' >&2
  exit 1
fi

readarray -t browser_settings < <(
  "$node_bin" --input-type=module - "$app_root/config.json" <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const home = os.homedir();
const profileDir = String(config.browserProfileDir || path.join(home, '.config', 'BraveSoftware', 'Brave-Browser')).trim();
const profileName = String(config.browserProfileName || 'Default').trim();
const cdpPort = Number(config.cdpPort || 9333);
if (!/^\d+$/.test(String(cdpPort)) || cdpPort < 1 || cdpPort > 65535) throw new Error('invalid cdpPort');
process.stdout.write(`${profileDir}\n${profileName}\n${cdpPort}\n`);
NODE
)
browser_profile_dir="${browser_settings[0]}"
browser_profile_name="${browser_settings[1]}"
cdp_port="${browser_settings[2]}"
display="${DISPLAY:-:10.0}"
xauthority="${XAUTHORITY:-$HOME/.Xauthority}"

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d -m 0755 "$unit_dir"
python3 - "$app_root" "$node_dir" "$unit_dir" "$browser_executable" "$browser_profile_dir" "$browser_profile_name" "$cdp_port" "$display" "$xauthority" <<'PY'
from pathlib import Path
import sys

(
    app_root,
    node_dir,
    unit_dir,
    browser_executable,
    browser_profile_dir,
    browser_profile_name,
    cdp_port,
    display,
    xauthority,
) = sys.argv[1:]
source = Path(app_root) / 'systemd' / 'user'
target = Path(unit_dir)
root_value = app_root
replacements = {
    '@APP_ROOT@': root_value,
    '@NODE_BIN_DIR@': node_dir,
    '@BROWSER_EXECUTABLE@': browser_executable,
    '@BROWSER_PROFILE_DIR@': browser_profile_dir,
    '@BROWSER_PROFILE_NAME@': browser_profile_name,
    '@CDP_PORT@': cdp_port,
    '@DISPLAY@': display,
    '@XAUTHORITY@': xauthority,
}
for name in (
    'r433-audit-controller.service',
    'r433-audit-dashboard.service',
    'r433-audit-watchdog.service',
    'r433-audit-watchdog.timer',
    'r433-source-browser.service',
):
    content = (source / name).read_text(encoding='utf-8')
    for key, value in replacements.items():
        content = content.replace(key, value)
    (target / name).write_text(content, encoding='utf-8')
PY

install -d -m 0700 "$app_root/data" "$app_root/logs"
systemctl --user daemon-reload
systemctl --user enable r433-source-browser.service r433-audit-controller.service r433-audit-dashboard.service r433-audit-watchdog.timer
systemctl --user start r433-source-browser.service r433-audit-controller.service r433-audit-dashboard.service r433-audit-watchdog.timer
printf 'Enabled source browser, controller, dashboard, and watchdog timer for %s\n' "$app_root"
printf '%s\n' 'Dashboard: http://127.0.0.1:9350/'
