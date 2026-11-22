ALTER TABLE "Pool" ADD COLUMN "category" TEXT, ADD COLUMN "deliveryState" TEXT, ADD COLUMN "deliveryLga" TEXT, ADD COLUMN "cluster" TEXT;

ALTER TABLE "PendingPool" ADD COLUMN "cluster" TEXT;

CREATE TABLE IF NOT EXISTS "ReputationTier" (
  "subject" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "tier" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ReputationTier_pkey" PRIMARY KEY ("subject", "role")
);

UPDATE "Pool" AS p SET "category" = o."category" FROM "Offer" AS o WHERE o."id" = p."offerId";

UPDATE "Pool" AS p
SET "deliveryState" = area.value->>'state', "deliveryLga" = area.value->>'lga'
FROM "Offer" AS o, LATERAL (
  SELECT value FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(o."deliveryAreas"::jsonb) = 'array' THEN o."deliveryAreas"::jsonb ELSE '[]'::jsonb END
  ) LIMIT 1
) AS area
WHERE o."id" = p."offerId";

UPDATE "Pool" AS p SET "cluster" = pending."cluster"
FROM "PendingPool" AS pending
WHERE pending."hubHash" = p."hubHash" AND pending."cluster" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Pool_state_id_idx" ON "Pool"("state", "id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Pool_state_category_id_idx" ON "Pool"("state", "category", "id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Pool_state_deliveryState_deliveryLga_id_idx" ON "Pool"("state", "deliveryState", "deliveryLga", "id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Pool_state_cluster_id_idx" ON "Pool"("state", "cluster", "id");
