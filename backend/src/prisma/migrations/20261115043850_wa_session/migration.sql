-- CreateTable
CREATE TABLE "wa_session" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wa_session_pkey" PRIMARY KEY ("key")
);
