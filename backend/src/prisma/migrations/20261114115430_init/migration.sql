-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('RUNNING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('BOOKED', 'REJECTED', 'NO_ANSWER', 'CALLBACK_LATER');

-- CreateEnum
CREATE TYPE "PlanInterest" AS ENUM ('BASIC', 'PREMIUM', 'ADVANCED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PortalStatus" AS ENUM ('NEW_LEAD', 'PROPOSAL_SENT', 'MEETING_SCHEDULED', 'CONVERTED', 'LOST');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'RUNNING',
    "total_calls" INTEGER NOT NULL DEFAULT 0,
    "booked" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "no_answer" INTEGER NOT NULL DEFAULT 0,
    "callback_later" INTEGER NOT NULL DEFAULT 0,
    "sarvam_campaign_id" TEXT,
    "cohort_id" TEXT,
    "agent_id" TEXT,
    "summary_call_sent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "campaign_id" UUID,
    "call_id" TEXT,
    "business_name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "contact_name" TEXT,
    "call_outcome" "CallOutcome" NOT NULL,
    "plan_interest" "PlanInterest" NOT NULL DEFAULT 'UNKNOWN',
    "requirements" TEXT,
    "preferred_time" TEXT,
    "duration_seconds" INTEGER,
    "meeting_link" TEXT,
    "meeting_time" TIMESTAMPTZ(6),
    "calendar_event_id" TEXT,
    "proposal_sent" BOOLEAN NOT NULL DEFAULT false,
    "proposal_url" TEXT,
    "portal_status" "PortalStatus" NOT NULL DEFAULT 'NEW_LEAD',
    "transcript" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" UUID NOT NULL,
    "client_id" UUID,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "plan" "PlanInterest" NOT NULL,
    "pdf" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_sarvam_campaign_id_key" ON "campaigns"("sarvam_campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_call_id_key" ON "clients"("call_id");

-- CreateIndex
CREATE INDEX "clients_campaign_id_idx" ON "clients"("campaign_id");

-- CreateIndex
CREATE INDEX "clients_call_outcome_idx" ON "clients"("call_outcome");

-- CreateIndex
CREATE INDEX "clients_created_at_idx" ON "clients"("created_at");

-- CreateIndex
CREATE INDEX "call_logs_client_id_idx" ON "call_logs"("client_id");

-- CreateIndex
CREATE INDEX "call_logs_timestamp_idx" ON "call_logs"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "proposals_seq_key" ON "proposals"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "proposals_number_key" ON "proposals"("number");

-- CreateIndex
CREATE INDEX "proposals_client_id_idx" ON "proposals"("client_id");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
