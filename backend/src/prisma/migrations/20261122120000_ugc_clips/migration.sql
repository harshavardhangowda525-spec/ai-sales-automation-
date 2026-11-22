CREATE TABLE "ugc_clips" (
  "id" UUID NOT NULL,
  "reel_id" UUID NOT NULL,
  "n" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ugc_clips_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ugc_clips_reel_id_n_key" ON "ugc_clips"("reel_id", "n");
