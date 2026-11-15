-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "awaiting_email" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "portal_client_id" TEXT,
ADD COLUMN     "portal_invite_link" TEXT,
ADD COLUMN     "portal_proposal_id" TEXT,
ADD COLUMN     "portal_proposal_link" TEXT,
ADD COLUMN     "portal_synced_at" TIMESTAMPTZ(6);
