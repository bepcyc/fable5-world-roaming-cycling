The second box (`ssh pop-os`) is a Ryzen 9 3950X / 128 GB / Radeon RX 6800 XT (RADV NAVI21) on Pop!_OS 24.04 — the obvious play/perf-target machine; node/npm are NOT installed there yet.

Inspected remotely 2026-07-02 (agent socket note below):
- Pop!_OS 24.04 LTS, kernel 6.18.7, X11 session, display 3440×1440 (DP-2).
- GPU: RX 6800 XT — roughly an order of magnitude above this dev box's Vega 7; LAAS's visual bar at real fps belongs THERE (ties to OPEN-QUESTIONS Q1 and ROADMAP M3.3 high-speed pass).
- Google Chrome 149 at `/usr/bin/google-chrome` (FHS — `just run-rxgpu`'s first candidate); chromium is a snap (avoid: confinement may break `--user-data-dir`/flags).
- `just` 1.42.4 present; **node/npm absent** — `run-rxgpu` guards for this and prints an nvm hint.
- **No Bluetooth adapter there either** (`/sys/class/bluetooth` empty) — the BLE milestone still needs a USB dongle whichever box hosts the trainer test (Q8).
- SSH from the dev box: keys live in the **gcr-ssh-agent** socket `/run/user/1000/gcr/ssh` (holds `bepcyc@pop-os` RSA). Non-interactive shells inherit the gpg-agent socket (`/run/user/1000/gnupg/S.gpg-agent.ssh`) which has NO identities — export `SSH_AUTH_SOCK=/run/user/1000/gcr/ssh` before ssh'ing from tooling.
