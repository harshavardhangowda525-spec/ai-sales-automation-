# Infinity Voice: setup guide

The cloud half (CRM + Agent Studio) is already part of the dashboard. This guide sets up the
**local half**: a Linux system next to your POCO C55 that handles the Bluetooth call audio.

> Nothing here roots or flashes the phone, and nothing repartitions your laptop. Steps that change
> your system say so and wait for you.

## 1. Choose the Linux environment

| Option | Bluetooth works? | Changes to the laptop |
|---|---|---|
| WSL2 on Windows | **No.** WSL2 can't use the laptop's Bluetooth radio. | — |
| VirtualBox/VMware VM | Only with a **USB Bluetooth adapter passed through**. The built-in adapter usually can't be. | none |
| **Ubuntu live USB** (try without installing) | Yes, if the laptop's adapter works on Linux | none. Recommended **first test** |
| Dual boot Ubuntu | Yes | new partition. **Only with your approval and a backup** |
| A spare Linux PC / old laptop | Yes | none |

Start with an Ubuntu 24.04 live USB ("Try Ubuntu") to run the audit.

## 2. Audit (read-only)

```bash
git clone https://github.com/harshavardhangowda525-spec/ai-sales-automation-.git
```

```bash
cd ai-sales-automation-/voice-gateway && bash audit.sh | tee audit.txt
```

Share `audit.txt`. It shows:
- whether the Bluetooth adapter works;
- whether PipeWire/WirePlumber are running;
- whether the phone offers HFP;
- whether `org.pipewire.Telephony` and CallScoot are present.

## 3. Pair the phone for calls

1. On the POCO C55: Settings → Bluetooth → pair with the Linux machine.
2. In the device's Bluetooth settings on the phone, enable **Phone calls**. Media is optional.
3. Check on Linux that the phone shows "Handsfree Audio Gateway": `bluetoothctl info <MAC>`

## 4. Install CallScoot and the speech engines

Follow CallScoot's own docs (https://github.com/efekurucay/callscoot, `docs/DEPLOYMENT.md`). Then
create the AI devices and configure the AI-only route, as its AI-VOICE-ROUTING guide shows:

```bash
callscoot-agent bootstrap-audio
```

```bash
callscoot configure --sink callscoot.agent.rx --source callscoot.agent.tx.monitor --echo-cancel off
```

```bash
systemctl --user restart callscoot-daemon.service
```

**Speech to text (whisper.cpp).** Build it from https://github.com/ggml-org/whisper.cpp and start the
server with a small model. `base` or `small` fits in 8 GB RAM; benchmark both.

```bash
./build/bin/whisper-server -m models/ggml-base.bin --port 8080
```

**Text to speech (Piper).** Install it from https://github.com/OHF-Voice/piper1-gpl and download a
voice. A 16 kHz `low` model skips resampling.

Node.js 20+ is also required.

## 5. Configure the gateway

```bash
cd voice-gateway && cp .env.example .env
```

Fill in `.env`:
- `VOICE_GATEWAY_TOKEN`: the same value as on Render.
- `PIPER_MODEL`: the path to your voice.

On Render (backend service → Environment), set:

| Variable | Value |
|---|---|
| `VOICE_GATEWAY_TOKEN` | a long random string (`openssl rand -hex 32`) |
| `ANTHROPIC_API_KEY` | from console.anthropic.com. **Paid per use**; without it replies are simulated |
| `VOICE_CLAUDE_MODEL` | optional, default `claude-opus-5-5` |
| `VOICE_LIVE_CALLING` | leave unset until the self-test passes |
| `VOICE_AUTO_ANSWER` | leave unset until `call_answering` is VERIFIED |
| `VOICE_COLD_CALLING_AUTHORIZED` | `true` to allow cold-call campaigns on your line |
| `VOICE_TELEMARKETER_ID` | your telemarketing registration / authorisation reference (stored on every cold call) |
| `VOICE_DAILY_CALL_CAP` | optional, default `100` real outbound calls per day |

## 6. Self-test (real calls, only when you run them)

```bash
node src/selftest.js status
```

Call a person who agreed to a test:

```bash
node src/selftest.js call +91XXXXXXXXXX --consent
```

Then ring the POCO C55 from another phone:

```bash
node src/selftest.js answer
```

Each capability becomes VERIFIED or FAILED from what actually happened:
- **Bluetooth, HFP, call initiation:** the call connects.
- **Incoming audio:** the caller's voice is measured digitally.
- **Outgoing audio:** the other person confirms they heard the test phrase.
- **Call answering:** an incoming call is answered without touching the phone.

The states are saved in `~/.config/infinity-voice/capabilities.json` and shown on the dashboard.

## 7. Start the gateway

```bash
node src/gateway.js
```

The dashboard's **Infinity Voice → Overview** should show **Online** with the capability states.
To run it in the background at login, use a systemd user service:

```bash
mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/infinity-voice.service <<'EOF'
[Unit]
Description=Infinity Voice gateway
After=pipewire.service wireplumber.service

[Service]
WorkingDirectory=%h/ai-sales-automation-/voice-gateway
ExecStart=/usr/bin/env node src/gateway.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
```

```bash
systemctl --user enable --now infinity-voice.service
```

## 8. Going live, in this order

1. Use the **Test console** (simulated, free with the mock; real Claude replies once the API key is set).
2. Inbound: set `VOICE_AUTO_ANSWER=true` and call the POCO C55 yourself.
3. Outbound follow-ups: mark consenting customers (`voice_consent`) with `PATCH /api/voice/consent/:clientId`,
   set `VOICE_LIVE_CALLING=true`, then queue a call from the dashboard API.
4. Cold calls:
   - set `VOICE_COLD_CALLING_AUTHORIZED=true` and `VOICE_TELEMARKETER_ID`;
   - go to **Campaigns → Start new campaign → Infinity Voice** and paste the leads.
   They're dialled one at a time.

**Emergency stop** is on the Overview page. It hangs up live calls, cancels the queue and blocks
pending commands.

## Troubleshooting

| Symptom | Check |
|---|---|
| Gateway "Offline" | `node src/gateway.js` running? `INFINITY_API_URL`/`VOICE_GATEWAY_TOKEN` match Render? |
| `telephony backend: none` | Phone connected with call audio on? `busctl --user list \| grep Telephony`, `curl 127.0.0.1:8788/v1/health` |
| `capture failed: spawn pacat` | Install `pulseaudio-utils` (provides `pacat`). PipeWire's pulse server must be running |
| Silence to the caller | `PIPER_MODEL` set? `pactl list short sinks` shows `callscoot.agent.tx`? CallScoot `--source callscoot.agent.tx.monitor`? |
| AI never hears the caller | Raise or lower `VAD_THRESHOLD`; check `callscoot.agent.rx.monitor` exists |
| Replies are "(simulated)" | `ANTHROPIC_API_KEY` is not set on Render |
| Calls show BLOCKED | The call detail lists the exact reasons (consent, hours, flags, weekly limit) |
