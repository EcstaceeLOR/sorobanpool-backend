-- Indexed time-window scans for admin dashboard counters.
CREATE INDEX "Pool_endedAt_state_idx" ON "Pool"("endedAt", "state");
CREATE INDEX "Pool_deliveredAt_state_idx" ON "Pool"("deliveredAt", "state");
CREATE INDEX "Pool_escrowBalance_idx" ON "Pool"("escrowBalance");
CREATE INDEX "Dispute_openedAt_idx" ON "Dispute"("openedAt");

-- Two-person approval requests for sensitive administrative actions.
CREATE TABLE "PendingAdminAction" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "PendingAdminAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PendingAdminAction_status_expiresAt_idx" ON "PendingAdminAction"("status", "expiresAt");
CREATE INDEX "PendingAdminAction_target_action_status_idx" ON "PendingAdminAction"("target", "action", "status");
