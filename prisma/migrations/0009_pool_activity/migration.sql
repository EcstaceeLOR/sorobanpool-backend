CREATE TABLE "PoolActivity" (
  "seq" SERIAL NOT NULL,
  "poolId" BIGINT NOT NULL,
  "type" TEXT NOT NULL,
  "actor" TEXT,
  "units" INTEGER,
  "tier" INTEGER,
  "ledger" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "aggregate" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "PoolActivity_pkey" PRIMARY KEY ("seq")
);

CREATE INDEX "PoolActivity_poolId_seq_idx" ON "PoolActivity"("poolId", "seq");
