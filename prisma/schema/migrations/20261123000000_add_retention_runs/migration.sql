CREATE TABLE "retention_runs" (
    "id" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "rowsDeleted" INTEGER NOT NULL DEFAULT 0,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retention_runs_tableName_createdAt_idx"
    ON "retention_runs"("tableName", "createdAt");