CREATE TYPE "ContractUpgradeStatus" AS ENUM ('PENDING', 'EXECUTED', 'CANCELLED');

CREATE TABLE "contract_upgrades" (
    "id" TEXT NOT NULL,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "executableAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "status" "ContractUpgradeStatus" NOT NULL DEFAULT 'PENDING',
    "scheduleTxHash" TEXT NOT NULL,
    "scheduleEventIndex" INTEGER NOT NULL,
    "executedTxHash" TEXT,
    "executedEventIndex" INTEGER,
    "cancelledTxHash" TEXT,
    "cancelledEventIndex" INTEGER,
    CONSTRAINT "contract_upgrades_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contract_upgrades_scheduleTxHash_scheduleEventIndex_key" ON "contract_upgrades"("scheduleTxHash", "scheduleEventIndex");
CREATE UNIQUE INDEX "contract_upgrades_executedTxHash_executedEventIndex_key" ON "contract_upgrades"("executedTxHash", "executedEventIndex");
CREATE UNIQUE INDEX "contract_upgrades_cancelledTxHash_cancelledEventIndex_key" ON "contract_upgrades"("cancelledTxHash", "cancelledEventIndex");
CREATE INDEX "contract_upgrades_status_scheduledAt_idx" ON "contract_upgrades"("status", "scheduledAt");
