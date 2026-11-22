#!/usr/bin/env bash
# One-time setup on the Oracle "Always Free" Ubuntu 24.04 machine (Ampere A1, arm64).
# Installs: a virtual screen (Xvfb), Chrome (Playwright's Chromium build), a remote screen for the
# one-time Google sign-in (x11vnc + noVNC, reachable ONLY through your SSH tunnel), ffmpeg, Node 20,
# and systemd services so everything restarts by itself after a reboot.
set -euo pipefail
cd "$(dirname "$0")"
ROBOT_DIR="$(pwd)"
USER_NAME="$(whoami)"

sudo apt-get update
sudo apt-get install -y xvfb x11vnc novnc websockify ffmpeg fonts-noto fonts-noto-color-emoji curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
npm install --omit=dev
npx -y playwright@1.48.2 install --with-deps chromium
CHROME="$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome | tail -1)"
[ -f .env ] || cp .env.example .env
mkdir -p ~/ugc-work ~/.config/ugc-chrome

sudo tee /etc/systemd/system/ugc-xvfb.service >/dev/null <<UNIT
[Unit]
Description=Virtual screen for the UGC robot
[Service]
User=$USER_NAME
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/ugc-chrome.service >/dev/null <<UNIT
[Unit]
Description=Signed-in Chrome for the UGC robot (debug port on localhost only)
After=ugc-xvfb.service
Requires=ugc-xvfb.service
[Service]
User=$USER_NAME
Environment=DISPLAY=:99
ExecStart=$CHROME --user-data-dir=/home/$USER_NAME/.config/ugc-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --start-maximized --lang=en-IN https://gemini.google.com/app
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/ugc-vnc.service >/dev/null <<UNIT
[Unit]
Description=Remote screen for the one-time Google sign-in (localhost only; use an SSH tunnel)
After=ugc-xvfb.service
[Service]
User=$USER_NAME
ExecStart=/bin/sh -c 'x11vnc -display :99 -localhost -forever -shared -nopw -quiet & exec websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900'
Restart=always
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/ugc-robot.service >/dev/null <<UNIT
[Unit]
Description=UGC robot (daily ad on the Gemini subscription)
After=ugc-chrome.service network-online.target
[Service]
User=$USER_NAME
WorkingDirectory=$ROBOT_DIR
ExecStart=/usr/bin/env node src/robot.js
Restart=always
RestartSec=30
[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now ugc-xvfb ugc-chrome ugc-vnc
echo
echo "Done. Next: fill in .env (UGC_ROBOT_TOKEN), sign in to Google through the remote screen (README step 4),"
echo "then: sudo systemctl enable --now ugc-robot"
