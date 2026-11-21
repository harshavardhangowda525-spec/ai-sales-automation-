#!/usr/bin/env bash
# Infinity Voice — Phase 3 environment audit. READ-ONLY: installs nothing, changes nothing.
# Run on the Linux machine that will talk to the phone:   bash audit.sh   (optionally: bash audit.sh > audit.txt)
set -u
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "== System"
info "Kernel: $(uname -sr)"
[ -r /etc/os-release ] && info "OS: $(. /etc/os-release; echo "$PRETTY_NAME")"
if grep -qi microsoft /proc/version 2>/dev/null; then bad "Running inside WSL — WSL2 has no access to the laptop's Bluetooth radio; HFP calling will not work here"; fi
if have systemd-detect-virt && [ "$(systemd-detect-virt 2>/dev/null)" != "none" ]; then info "Virtualised: $(systemd-detect-virt) — the Bluetooth adapter must be passed through (USB passthrough)"; fi
info "RAM: $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo)"

echo "== Bluetooth hardware"
if have rfkill; then rfkill list bluetooth 2>/dev/null | sed 's/^/    /'; rfkill list bluetooth 2>/dev/null | grep -q "blocked: yes" && bad "Bluetooth is blocked (rfkill)"; fi
if [ -d /sys/class/bluetooth ] && ls /sys/class/bluetooth | grep -q hci; then ok "Adapter(s): $(ls /sys/class/bluetooth | tr '\n' ' ')"; else bad "No Bluetooth adapter visible to Linux"; fi
if have bluetoothctl; then
  ok "bluetoothctl: $(bluetoothctl --version 2>/dev/null)"
  bluetoothctl show 2>/dev/null | grep -E "Controller|Powered|Name:" | sed 's/^/    /'
  echo "    Paired devices:"; bluetoothctl devices Paired 2>/dev/null | sed 's/^/      /'
  for mac in $(bluetoothctl devices Paired 2>/dev/null | awk '{print $2}'); do
    bluetoothctl info "$mac" 2>/dev/null | grep -qi "Handsfree Audio Gateway\|0000111f" && ok "$mac advertises Hands-Free Audio Gateway (phone side of HFP)"
    bluetoothctl info "$mac" 2>/dev/null | grep -q "Connected: yes" && info "$mac is connected"
  done
else bad "bluetoothctl not installed (package: bluez)"; fi

echo "== Audio stack"
if have pactl && pactl info >/dev/null 2>&1; then ok "Sound server: $(pactl info | awk -F': ' '/Server Name/ {print $2}')"; else bad "pactl not working (package: pulseaudio-utils / pipewire-pulse)"; fi
for p in pipewire wireplumber pipewire-pulse; do pgrep -x "$p" >/dev/null && ok "$p running" || bad "$p not running"; done
if have wpctl; then info "WirePlumber: $(wpctl status 2>/dev/null | head -n 1)"; fi
echo "    Bluetooth cards / profiles:"
pactl list cards 2>/dev/null | awk '/Name: bluez_card/ {p=1; print "      "$0} p && /headset-head-unit|handsfree|hfp|hsp/ {print "      "$0} /^$/ {p=0}'
pactl list cards 2>/dev/null | grep -qiE "headset-head-unit|handsfree_head_unit|hfp" && ok "An HFP/HSP profile is offered by a connected device" || info "No HFP profile seen (connect the phone, then re-run)"

echo "== PipeWire telephony (D-Bus)"
if have busctl && busctl --user list 2>/dev/null | grep -q "org.pipewire.Telephony"; then
  ok "org.pipewire.Telephony is on the session bus"
  busctl --user call org.pipewire.Telephony /org/pipewire/Telephony org.ofono.Manager GetModems 2>/dev/null | sed 's/^/    /'
else info "org.pipewire.Telephony not on the session bus (needs a recent PipeWire with bluez5 telephony enabled)"; fi

echo "== CallScoot"
if have callscoot; then ok "callscoot installed"; callscoot status 2>/dev/null | head -n 30 | sed 's/^/    /'; else info "callscoot not installed"; fi
curl -s -m 2 http://127.0.0.1:8788/v1/health >/dev/null 2>&1 && ok "CallScoot API answering on 127.0.0.1:8788" || info "CallScoot API not reachable on 127.0.0.1:8788"
pactl list short sinks 2>/dev/null | grep -q "callscoot.agent.rx" && ok "Virtual sink callscoot.agent.rx exists" || info "callscoot.agent.rx missing (run: callscoot-agent bootstrap-audio)"
pactl list short sinks 2>/dev/null | grep -q "callscoot.agent.tx" && ok "Virtual sink callscoot.agent.tx exists" || info "callscoot.agent.tx missing"

echo "== Speech + tools"
for b in node pacat paplay busctl adb piper whisper-server whisper-cli; do have "$b" && ok "$b: $(command -v $b)" || info "$b not found"; done
have node && info "node $(node -v)"
echo
echo "Done. Nothing was changed. Share this output to plan the next step."
