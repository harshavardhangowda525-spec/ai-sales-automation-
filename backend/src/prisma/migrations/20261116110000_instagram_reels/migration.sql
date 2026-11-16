-- Daily Instagram reels + self-updating settings
ALTER TYPE "OwnerCallType" ADD VALUE IF NOT EXISTS 'REEL';

CREATE TABLE "reels" (
    "id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "topic" TEXT,
    "caption" TEXT,
    "video" BYTEA,
    "video_size" INTEGER,
    "run_url" TEXT,
    "instructions" TEXT,
    "ig_container_id" TEXT,
    "ig_media_id" TEXT,
    "ig_permalink" TEXT,
    "error" TEXT,
    "ready_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "posted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "reels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reels_day_key" ON "reels"("day");

CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
