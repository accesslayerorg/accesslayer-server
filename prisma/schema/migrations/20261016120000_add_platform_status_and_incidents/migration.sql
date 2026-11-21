-- Platform status health check and incident log (#1015)

CREATE TABLE "platform_incidents" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "services" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'investigating',
    "impact" TEXT NOT NULL DEFAULT 'minor',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_status_probes" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_status_probes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_incidents_status_idx" ON "platform_incidents"("status");
CREATE INDEX "platform_incidents_createdAt_idx" ON "platform_incidents"("createdAt");
CREATE INDEX "platform_status_probes_service_createdAt_idx" ON "platform_status_probes"("service", "createdAt");
