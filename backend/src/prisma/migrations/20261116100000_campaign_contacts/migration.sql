-- Phone → business name for campaigns (Sarvam call records only carry a hash of the name)
ALTER TABLE "campaigns" ADD COLUMN "contacts" JSONB;
