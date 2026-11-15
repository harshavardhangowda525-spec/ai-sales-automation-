-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT,
    "phone" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_calls" (
    "id" UUID NOT NULL,
    "contact_id" UUID,
    "to_name" TEXT NOT NULL,
    "to_phone" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'calling',
    "attempt_id" TEXT,
    "summary" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "relay_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "relay_calls_to_phone_status_idx" ON "relay_calls"("to_phone", "status");

-- AddForeignKey
ALTER TABLE "relay_calls" ADD CONSTRAINT "relay_calls_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
