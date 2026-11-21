-- Infinity Voice cold-call campaigns
ALTER TABLE "campaigns" ADD COLUMN "engine" TEXT NOT NULL DEFAULT 'sarvam';
ALTER TABLE "voice_calls" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'follow_up',
  ADD COLUMN "authorization_ref" TEXT;
