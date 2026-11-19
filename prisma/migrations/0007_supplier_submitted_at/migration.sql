ALTER TABLE "SupplierProfile" ADD COLUMN "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "SupplierProfile_kybStatus_submittedAt_idx" ON "SupplierProfile"("kybStatus", "submittedAt");
