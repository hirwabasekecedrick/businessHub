-- CreateTable
CREATE TABLE "reference_set" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "set" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_set_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reference_set_organization_id_set_key" ON "reference_set"("organization_id", "set");

-- AddForeignKey
ALTER TABLE "reference_set" ADD CONSTRAINT "reference_set_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
