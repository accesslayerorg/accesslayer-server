SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal';
