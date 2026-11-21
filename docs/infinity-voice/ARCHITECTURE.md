# Infinity Voice: architecture (as implemented)

Infinity Voice adds AI phone agents to the existing Infinity CRM. It is **not a separate system**:
- Leads and customers are the existing `Client` rows.
- Approvals are the existing `OwnerCall` queue, so Jarvis calls sir about them.
- Meetings go on the existing Google Calendar / Meet integration.
- Activity goes to the existing `CallLog` feed.

## The two halves

```text
┌──────────────────────── Cloud (Render, existing backend) ────────────────────────┐
│ Infinity CRM (Express + Prisma + Neon)                                            │
│  ├─ /api/voice/*      Agent Studio API (admin token)                              │
│  ├─ /voice-gateway/*  Gateway API (VOICE_GATEWAY_TOKEN)                           │
│  └─ services/voice/                                                               │
│      orchestrator.js  call queue, single-SIM lock, eligibility, retries, e-stop   │
│      stateMachine.js  CREATED → … → CRM_SYNCED (+ BLOCKED/BUSY/NO_ANSWER/…)       │
│      agentEngine.js   one turn: Claude + typed CRM tools, validation, permissions │
│      aiProvider.js    ClaudeProvider (Anthropic SDK) | MockProvider               │
│      crmAdapter.js    getLead, getCallEligibility, bookAppointment, approvals…    │
└───────────────────────────────▲──────────────────────────────────────────────────┘
                                │ HTTPS, gateway polls every 2 s (cloud never connects in)
┌───────────────────────────────┴──── Sir's Linux machine (voice-gateway/) ─────────┐
│ gateway.js   heartbeat + commands (DIAL/ANSWER/HANGUP) + phone-state events       │
│ telephony.js BluetoothTelephonyGateway                                            │
│              1) PipeWire  org.pipewire.Telephony (D-Bus, via busctl --user)       │
│              2) fallback  CallScoot API 127.0.0.1:8788 (dialing via ADB)          │
│ audio.js     AudioBridge: pacat ← callscoot.agent.rx.monitor / → callscoot.agent.tx│
│              (16 kHz mono s16le), energy VAD, barge-in, real RMS levels           │
│ speech.js    whisper.cpp server (STT) · Piper (TTS) — both local                  │
│ selftest.js  the ONLY code that marks a capability VERIFIED / FAILED              │
└───────────────────────────────▲──────────────────────────────────────────────────┘
              BlueZ + PipeWire/WirePlumber, Bluetooth HFP (laptop = Hands-Free unit)
                                │
                     POCO C55 (Audio Gateway) + Airtel SIM → customer's phone
```

## Audio path (no microphone, no speaker)

Customer voice → cellular → POCO C55 → **Bluetooth HFP** → PipeWire → CallScoot routes it into the
virtual sink `callscoot.agent.rx` → the gateway reads `callscoot.agent.rx.monitor` → VAD finds the
end of the phrase → whisper.cpp transcribes it → `POST /voice-gateway/calls/:id/turn` → the agent
engine (Claude + CRM tools) replies with text → Piper synthesises it → 16 kHz PCM is written to
`callscoot.agent.tx` → CallScoot → HFP → phone → customer.

HFP voice is narrowband/wideband (CVSD 8 kHz or mSBC 16 kHz). The bridge always works at 16 kHz
mono, which is the format CallScoot documents for these devices. Piper output is resampled to 16 kHz.

## Call control

| Action | PipeWire telephony (primary) | CallScoot fallback |
|---|---|---|
| List calls / state | `org.ofono.VoiceCallManager.GetCalls` on `/org/pipewire/Telephony/agN` | `GET /v1/current-call` |
| Dial | `org.pipewire.Telephony.AudioGateway1.Dial(s)` | `POST /v1/outbound-calls` (ADB path) |
| Answer | `org.pipewire.Telephony.Call1.Answer()` | `POST /v1/current-call/answer` |
| Hang up | `Call1.Hangup()` / `AudioGateway1.HangupAll()` | `POST /v1/current-call/hangup` |

Phone states (`incoming`, `dialing`, `alerting`, `active`, `disconnected`) are polled and sent to the
cloud as events, which drive the state machine. ADB only ever controls calls; it never carries audio.

## Call state machine

`CREATED → ELIGIBILITY_CHECK → QUEUED → GATEWAY_READY → DIALING → RINGING → CONNECTED → AI_ACTIVE → COMPLETED → CRM_SYNCED`

Side states: `BLOCKED`, `BUSY`, `NO_ANSWER`, `REJECTED`, `FAILED`, `CANCELLED`, `ESCALATED`,
`RETRY_PENDING`, `GATEWAY_DISCONNECTED`.

How transitions work:
- Every transition is checked against an allow-list.
- Each one is written as a conditional update (`WHERE state = <from>`), so two writers can't race.
- Each one is logged to `voice_call_events`.

## Safety gates (all must pass before a real outbound dial)

1. The person is a CRM client, is not `do_not_call` (checked on every record for that number), and
   has a valid Indian mobile number.
   - Follow-ups need **recorded consent** (`voice_consent`).
   - **Cold calls** (`purpose: 'cold'`) instead need sir's switch `VOICE_COLD_CALLING_AUTHORIZED=true`
     and his telemarketing reference `VOICE_TELEMARKETER_ID`. That reference is stored on every
     cold call (`voice_calls.authorization_ref`).
2. Within calling hours (default 10:00–19:00 IST, Mon–Sat), fewer than 3 real dial attempts to that
   number this week, under the daily cap (`VOICE_DAILY_CALL_CAP`, default 100), and no other call to
   them queued or in progress.
3. The agent has `can_call_out`, the server has `VOICE_LIVE_CALLING=true`, and emergency stop is off.
4. The gateway is online and reports `call_initiation = VERIFIED` (only `selftest.js` sets this).
5. **One call at a time** on the single SIM. Everything else waits in the queue, and eligibility is
   re-checked just before dialling.

Inbound auto-answer needs `VOICE_AUTO_ANSWER=true`, `call_answering = VERIFIED` and an active Receptionist agent.

## Cold-call campaigns (two engines)

Who calls whom:
- **Jarvis** calls sir on **Sarvam**: notices, approvals, summaries and reports.
- **Sarvam campaigns** are unchanged.
- **Infinity Voice campaigns** (`campaigns.engine = 'infinity_voice'`) cold-call from sir's own line.

How an Infinity Voice campaign runs (`services/voice/voiceCampaigns.js`):
1. `POST /api/campaign/start` with `engine: 'infinity_voice'` creates one `Client` row per lead.
   Duplicates and do-not-call numbers are skipped.
2. Every queue pass, the next uncalled lead gets a `requestLiveCall` with the Sales agent and
   `purpose: 'cold'`. This happens only when the line is free, inside calling hours and under the daily cap.
3. After each call is synced:
   - the campaign stats are recomputed;
   - a **BOOKED** lead gets the usual Meet + proposal, and the quotation goes to sir first.
4. When every lead has had its call, Jarvis phones sir with the campaign summary (on Sarvam).

During the call, the Sales agent:
- says who is calling and why;
- says it is an AI assistant if asked;
- on "not interested / stop calling", records the opt-out (do-not-call) and ends politely.

## AI turn

`agentEngine.runTurn` sends the following to Claude through the official Anthropic SDK (`client.beta.messages.create`):
- a cached system prompt: persona + business facts + the plan prices from the proposal system + the knowledge base;
- a per-call customer context block;
- the conversation so far.

Settings:
- Default model `claude-opus-5-5` (`VOICE_CLAUDE_MODEL`), effort `low` for speed (`VOICE_CLAUDE_EFFORT`).
- Server-side refusal fallback is enabled.

Tool handling:
- Tools are strict JSON schemas, re-validated before execution.
- Each agent can use only its `allowed_tools`.
- Simulated calls never write to the CRM.

Tools: `get_customer_context`, `check_availability`, `book_appointment`, `update_qualification`,
`create_follow_up`, `request_owner_approval`, `record_opt_out`, `end_call`.

## Owner approvals and the single SIM

`request_owner_approval` creates an `OwnerCall` of type `VOICE_APPROVAL`, and Jarvis calls sir about it.
- These calls go out on the **Sarvam number**, not the POCO C55 SIM, so they never compete with the
  customer call on the phone.
- The agent never promises the outcome. It tells the customer the founder will confirm.
- The decision is recorded on the call timeline, and the CRM is updated.

## What is deliberately NOT here

- **No Asterisk yet.** With one SIM and no SIP trunk, it would only add a hop and latency
  (Phase 8 decision in IMPLEMENTATION_STATUS.md).
- No call audio is recorded. Only text transcripts are stored.
