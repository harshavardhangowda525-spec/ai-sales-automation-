-- Infinity Voice foundation
ALTER TYPE "OwnerCallType" ADD VALUE IF NOT EXISTS 'VOICE_APPROVAL';

ALTER TABLE "clients" ADD COLUMN "voice_consent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "do_not_call" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consent_note" TEXT;

CREATE TABLE "voice_agents" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "personality" TEXT,
    "voice" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en-IN',
    "greeting" TEXT NOT NULL,
    "objectives" TEXT,
    "escalation_rules" TEXT,
    "allowed_tools" TEXT[],
    "can_call_out" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "voice_agents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "voice_calls" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "client_id" UUID,
    "direction" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "phone" TEXT,
    "state" TEXT NOT NULL DEFAULT 'CREATED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "connected_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER,
    "outcome" TEXT,
    "intent" TEXT,
    "summary" TEXT,
    "qualification_score" INTEGER,
    "objections" TEXT,
    "next_action" TEXT,
    "follow_up_at" TIMESTAMPTZ(6),
    "transcript" JSONB,
    "ai_messages" JSONB,
    "usage" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_calls_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "voice_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "voice_calls_state_next_attempt_at_idx" ON "voice_calls"("state", "next_attempt_at");
CREATE INDEX "voice_calls_client_id_idx" ON "voice_calls"("client_id");
CREATE INDEX "voice_calls_created_at_idx" ON "voice_calls"("created_at");

CREATE TABLE "voice_call_events" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voice_call_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "voice_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "voice_call_events_call_id_at_idx" ON "voice_call_events"("call_id", "at");

CREATE TABLE "voice_knowledge" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "voice_knowledge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "voice_gateway_commands" (
    "id" UUID NOT NULL,
    "call_id" UUID,
    "command" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "voice_gateway_commands_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "voice_gateway_commands_status_created_at_idx" ON "voice_gateway_commands"("status", "created_at");
