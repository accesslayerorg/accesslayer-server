-- Track unstaking on staking positions (#881)
ALTER TABLE "staking_positions" ADD COLUMN "unstakedAt" TIMESTAMP(3);

CREATE INDEX "staking_positions_wallet_unstakedAt_idx" ON "staking_positions"("wallet", "unstakedAt");
