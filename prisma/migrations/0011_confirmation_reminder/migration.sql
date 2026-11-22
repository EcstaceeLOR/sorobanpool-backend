-- CreateTable
CREATE TABLE "ConfirmationReminder" (
    "poolId" BIGINT NOT NULL,
    "userId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfirmationReminder_pkey" PRIMARY KEY ("poolId", "userId")
);
