-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "build_finished_at" TIMESTAMPTZ(6),
ADD COLUMN     "build_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "build_run_url" TEXT,
ADD COLUMN     "build_status" TEXT;
