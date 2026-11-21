// src/modules/reports/key-reports.service.ts
// Key report submission and moderator queue (#1226).
//
// Duplicate protection: a wallet may hold at most one `open` report per key.
// Submission runs inside a transaction that first takes a transaction-scoped
// Postgres advisory lock on (keyId, reporter), so concurrent submissions from
// the same wallet for the same key serialise and the check-then-insert cannot
// race. A partial unique index (WHERE status = 'open') would also work but
// cannot be expressed in the Prisma schema, so later `prisma migrate dev`
// runs would try to drop it.

import type { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { encodeCursor } from '../../utils/cursor.utils';
import { decodeCreatorFeedCursor } from '../../utils/creator-feed-cursor.utils';
import {
   CreateKeyReportBody,
   isValidKeyReportTransition,
   KeyReportStatusValue,
   ListKeyReportsQuery,
} from './key-reports.schemas';

export class KeyReportKeyNotFoundError extends Error {
   constructor(public readonly keyId: string) {
      super(`Key ${keyId} not found`);
      this.name = 'KeyReportKeyNotFoundError';
   }
}

export class DuplicateOpenKeyReportError extends Error {
   constructor(public readonly existingReportId: string) {
      super('You already have an open report for this key');
      this.name = 'DuplicateOpenKeyReportError';
   }
}

export class KeyReportNotFoundError extends Error {
   constructor(public readonly reportId: string) {
      super(`Report ${reportId} not found`);
      this.name = 'KeyReportNotFoundError';
   }
}

export class InvalidKeyReportTransitionError extends Error {
   constructor(
      public readonly from: KeyReportStatusValue,
      public readonly to: KeyReportStatusValue
   ) {
      super(`Cannot transition report from "${from}" to "${to}"`);
      this.name = 'InvalidKeyReportTransitionError';
   }
}

export class InvalidKeyReportCursorError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'InvalidKeyReportCursorError';
   }
}

export interface KeyReportDto {
   id: string;
   keyId: string;
   reporter: string;
   reason: string;
   details: string | null;
   status: KeyReportStatusValue;
   createdAt: string;
   updatedAt: string;
}

export interface KeyReportPage {
   data: KeyReportDto[];
   meta: {
      limit: number;
      hasMore: boolean;
      nextCursor: string | null;
   };
}

type KeyReportRow = {
   id: string;
   keyId: string;
   reporter: string;
   reason: string;
   details: string | null;
   status: string;
   createdAt: Date;
   updatedAt: Date;
};

function toDto(row: KeyReportRow): KeyReportDto {
   return {
      id: row.id,
      keyId: row.keyId,
      reporter: row.reporter,
      reason: row.reason,
      details: row.details,
      status: row.status as KeyReportStatusValue,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
   };
}

/** Prisma P2003: foreign key constraint failed (duck-typed so it is mock-safe). */
function isForeignKeyViolation(error: unknown): boolean {
   return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2003'
   );
}

export async function createKeyReport(
   keyId: string,
   reporter: string,
   input: CreateKeyReportBody
): Promise<KeyReportDto> {
   const key = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!key) throw new KeyReportKeyNotFoundError(keyId);

   try {
      const created = await prisma.$transaction(async tx => {
         // Serialise submissions for this (key, reporter) pair until commit.
         await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${keyId}::text), hashtext(${reporter}::text))`;

         const existing = await tx.keyReport.findFirst({
            where: { keyId, reporter, status: 'open' },
            select: { id: true },
         });
         if (existing) throw new DuplicateOpenKeyReportError(existing.id);

         return tx.keyReport.create({
            data: {
               keyId,
               reporter,
               reason: input.reason,
               details: input.details ? input.details : null,
            },
         });
      });
      return toDto(created);
   } catch (error) {
      // Key deleted between the existence check and the insert.
      if (isForeignKeyViolation(error))
         throw new KeyReportKeyNotFoundError(keyId);
      throw error;
   }
}

export async function listKeyReports(
   query: ListKeyReportsQuery
): Promise<KeyReportPage> {
   const where: Prisma.KeyReportWhereInput = {};
   if (query.status) where.status = query.status;

   if (query.cursor) {
      const decoded = decodeCreatorFeedCursor(query.cursor);
      if (!decoded.ok) throw new InvalidKeyReportCursorError(decoded.error);
      const cursorDate = new Date(decoded.payload.createdAt);
      if (Number.isNaN(cursorDate.getTime())) {
         throw new InvalidKeyReportCursorError(
            'Cursor has an invalid timestamp'
         );
      }
      // Keyset pagination on (createdAt DESC, id DESC).
      where.OR = [
         { createdAt: { lt: cursorDate } },
         { createdAt: cursorDate, id: { lt: decoded.payload.id } },
      ];
   }

   const rows = await prisma.keyReport.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
   });

   const hasMore = rows.length > query.limit;
   const page = hasMore ? rows.slice(0, query.limit) : rows;
   const last = page[page.length - 1];

   return {
      data: page.map(toDto),
      meta: {
         limit: query.limit,
         hasMore,
         nextCursor:
            hasMore && last
               ? encodeCursor({
                    createdAt: last.createdAt.toISOString(),
                    id: last.id,
                 })
               : null,
      },
   };
}

export async function updateKeyReportStatus(
   reportId: string,
   nextStatus: KeyReportStatusValue
): Promise<KeyReportDto> {
   const report = await prisma.keyReport.findUnique({
      where: { id: reportId },
   });
   if (!report) throw new KeyReportNotFoundError(reportId);

   const current = report.status as KeyReportStatusValue;
   if (!isValidKeyReportTransition(current, nextStatus)) {
      throw new InvalidKeyReportTransitionError(current, nextStatus);
   }

   // Compare-and-set on the status we validated against, so two moderators
   // acting concurrently cannot both apply a transition from the same state.
   const result = await prisma.keyReport.updateMany({
      where: { id: reportId, status: current },
      data: { status: nextStatus },
   });
   if (result.count === 0) {
      const latest = await prisma.keyReport.findUnique({
         where: { id: reportId },
         select: { status: true },
      });
      if (!latest) throw new KeyReportNotFoundError(reportId);
      throw new InvalidKeyReportTransitionError(
         latest.status as KeyReportStatusValue,
         nextStatus
      );
   }

   const updated = await prisma.keyReport.findUnique({
      where: { id: reportId },
   });
   if (!updated) throw new KeyReportNotFoundError(reportId);
   return toDto(updated);
}
