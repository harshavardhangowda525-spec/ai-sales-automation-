-- CreateEnum
CREATE TYPE "WebsiteStage" AS ENUM ('NOT_STARTED', 'PROMPT_READY', 'IN_DEVELOPMENT', 'IN_REVIEW', 'READY', 'DELIVERED');

-- AlterEnum
ALTER TYPE "OwnerCallType" ADD VALUE 'UPDATE';

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "website_preview_url" TEXT,
ADD COLUMN     "website_prompt" TEXT,
ADD COLUMN     "website_prompt_at" TIMESTAMPTZ(6),
ADD COLUMN     "website_prompt_source" TEXT,
ADD COLUMN     "website_stage" "WebsiteStage" NOT NULL DEFAULT 'NOT_STARTED';
