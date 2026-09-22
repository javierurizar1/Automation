# Linux user-level services

The Linux service files run the controller and loopback dashboard under the signed-in user's systemd manager. The installer does not require root. It checks for Node.js, npm, dependencies, and the private `config.json` before installing units.

```bash
scripts/install-systemd-user.sh
```

The installer copies units to `~/.config/systemd/user`, enables the visible persistent source browser, controller, dashboard, and watchdog timer. The source browser opens a committed data bootstrap page on the configured CDP port. After attaching, the controller navigates that same authenticated profile to the configured ChatGPT project URL with a bounded timeout. The controller and dashboard listen only on the configured loopback addresses. The dashboard defaults to `http://127.0.0.1:9350/`.

## Recovery behavior

The watchdog timer runs once per 30 seconds after a 60-second boot grace period. It reads the controller heartbeat, process identity, systemd unit state, desired control state, and browser connection health. It does not read or edit registry results, case data, source packs, reviewer conversations, or bucket state.

- A user-requested `STOPPED` or `PAUSED` control state suppresses automatic starts.
- A service that is starting or recovering gets a bounded 120-second grace period.
- A disconnected browser gets a 90-second recovery grace period while the controller heartbeat remains fresh.
- Controller recovery uses exponential backoff starting at 60 seconds, capped at 10 minutes, with no more than three watchdog recovery actions in a rolling 30-minute window.
- The controller unit separately limits automatic failure restarts to three starts in 30 minutes. Exhausted recovery is shown as `DEGRADED`; it does not produce an endless restart loop.
- Watchdog state and classified failures are atomically written to `data/watchdog-state.json` and `data/incidents/` for the dashboard.

The dashboard's **STOP AUTOMATION** control records `STOPPED` and stops the controller unit. **RESTART AUTOMATION** records `RUNNING`, clears a systemd failure limit if needed, and starts or restarts the controller. The watchdog timer and dashboard remain available while automation is stopped.

## Operations

```bash
systemctl --user status r433-audit-controller.service r433-audit-dashboard.service r433-audit-watchdog.timer
journalctl --user -u r433-audit-controller.service -u r433-audit-watchdog.service --since today
```

The user service manager normally starts when the user logs in. On a headless machine that must recover before login, configure user lingering through the machine's normal administrator policy. To disable reboot startup, stop automation in the dashboard, then run `systemctl --user disable --now r433-audit-controller.service r433-audit-dashboard.service r433-audit-watchdog.timer`.
