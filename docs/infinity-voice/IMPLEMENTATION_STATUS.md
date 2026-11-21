# Infinity Voice: implementation status

_Last updated: 2026-11-21_

Legend: ✅ built and tested · 🟡 built, not yet tested on real hardware · ⛔ blocked · ⏳ not started

## Phase by phase

| Phase | Status | Evidence / notes |
|---|---|---|
| 1. CRM analysis | ✅ | Reuses `Client`, `CallLog`, `OwnerCall`, Google Calendar/Meet and the proposal plan prices. No duplicate tables. |
| 2. Voice foundation | ✅ | Agents, call model, state machine, orchestrator, CRM adapter, mock gateway, Agent Studio page. **16/16 backend tests pass** (`backend/test/voice.test.js`, real Postgres). |
| 3. Bluetooth environment audit | 🟡 | `voice-gateway/audit.sh` (read-only) is written and runs. It **has not been run on sir's laptop yet**. |
| 4. CallScoot integration | 🟡 | `telephony.js` uses the documented PipeWire D-Bus API, with CallScoot's API as fallback. `audio.js` uses CallScoot's documented virtual devices. Gateway↔cloud protocol tested end to end with a **stand-in CallScoot server** (dial → alerting → active → hang-up from dashboard → CRM_SYNCED). |
| 5. Digital audio proof of concept | ⛔ | Needs the Linux machine + POCO C55 + a consenting test caller: `node src/selftest.js call <number> --consent`. |
| 6. Claude voice engine | 🟡 | ClaudeProvider is implemented with the official SDK. Fully tested with the **MockProvider** only: no `ANTHROPIC_API_KEY` is configured, and the key costs money per call. STT (whisper.cpp) and TTS (Piper) adapters are written but not yet run with real audio. |
| 7. End-to-end AI phone call | ⛔ | Depends on 5 and 6. |
| 8. Asterisk | ⏳ (deliberately) | Not justified for one SIM: it adds a media hop and latency and gives no SIP interoperability without a SIP trunk. Revisit if a SIP provider or a second line is added. |
| 9. CRM automation | ✅ (simulated) / 🟡 (live) | Eligibility, consent, opt-out → do-not-call, summaries in the activity feed, follow-ups, bookings and owner approvals. Exercised in tests; live writes happen only on LIVE calls. |
| 9b. Cold-call campaigns | ✅ (simulated) / 🟡 (live) | Campaign engine `infinity_voice`: one-at-a-time pacing, authorisation reference on each call, BOOKED → Meet + proposal (sir approves), summary call via Jarvis/Sarvam when finished. Tested end to end with the simulated gateway. |
| 10. Agent Studio | ✅ | `/voice` page: Overview (real gateway health, capability states, audio meters, emergency stop), Agents (builder, versioned on every save), Test console (simulated, with tool and latency inspection), Calls (history, analytics, transcript, hang-up), Knowledge. |
| 11. Reliability | 🟡 | Health heartbeat, stale-command expiry, capped retries (2, 30 min apart), emergency stop that expires pending commands, gateway survives missing audio tools. No systemd unit tested yet. |
| 12. Release testing | ⛔ | Needs real hardware. |

## Capability states (from the gateway; only the self-test can change these)

| Capability | State |
|---|---|
| Bluetooth connection | UNKNOWN |
| HFP profile | UNKNOWN |
| Incoming audio | UNKNOWN |
| Outgoing audio | UNKNOWN |
| Call initiation | UNKNOWN |
| Call answering | UNKNOWN |
| Autonomous operation | UNKNOWN |

**No real phone call has been made through Infinity Voice yet.**

## Current blockers

1. **A Linux environment with Bluetooth is needed.**
   - The laptop runs Windows.
   - WSL2 cannot reach the laptop's Bluetooth radio.
   - Options are in SETUP_GUIDE.md: a live USB first (non-destructive), or a dual boot later, with sir's approval.
2. **CallScoot must be installed** on that Linux system, and the phone paired for calls (HFP).
3. **`ANTHROPIC_API_KEY`** is needed for real Claude replies. A Claude subscription is not API access.
   Until then the MockProvider is used and every reply is labelled `(simulated)`.
4. **Consent records:**
   - Outbound calls go only to customers with `voice_consent = true`.
   - Follow-ups need `voice_consent`.
   - Cold-call campaigns run once sir sets `VOICE_COLD_CALLING_AUTHORIZED=true` and
     `VOICE_TELEMARKETER_ID`. Do-not-call, calling hours, the weekly per-number limit and the daily
     cap still apply.

## Next steps

1. Run `bash voice-gateway/audit.sh` on the Linux environment and share the output.
2. Install the CallScoot, whisper.cpp and Piper setup (SETUP_GUIDE.md), then `node src/selftest.js status`.
3. Run a consenting test call: `node src/selftest.js call +91XXXXXXXXXX --consent`, then `node src/selftest.js answer`.
4. Add `ANTHROPIC_API_KEY` (and `VOICE_GATEWAY_TOKEN`) on Render.
5. Start the gateway and do a simulated-then-live inbound test with auto-answer on.
6. Only then set `VOICE_LIVE_CALLING=true` for consented follow-up calls.
