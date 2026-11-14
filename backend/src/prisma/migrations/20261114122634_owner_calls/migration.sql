-- CreateEnum
CREATE TYPE "OwnerCallType" AS ENUM ('SUMMARY', 'QUOTATION', 'WEBSITE');

-- CreateEnum
CREATE TYPE "OwnerCallStatus" AS ENUM ('QUEUED', 'CALLING', 'APPROVED', 'REJECTED', 'NEEDS_MANUAL', 'SENT', 'DONE', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "website_sent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "website_url" TEXT;

-- CreateTable
CREATE TABLE "owner_calls" (
    "id" UUID NOT NULL,
    "type" "OwnerCallType" NOT NULL,
    "status" "OwnerCallStatus" NOT NULL DEFAULT 'QUEUED',
    "client_id" UUID,
    "campaign_id" UUID,
    "data" JSONB,
    "attempt_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "called_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "owner_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_calls_status_next_attempt_at_idx" ON "owner_calls"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "owner_calls_client_id_idx" ON "owner_calls"("client_id");

-- AddForeignKey
ALTER TABLE "owner_calls" ADD CONSTRAINT "owner_calls_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_calls" ADD CONSTRAINT "owner_calls_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
