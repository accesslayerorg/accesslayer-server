// src/modules/keys/key-retirement.service.ts
//
// Key retirement status and history service (#1116).

import { prisma } from '../../utils/prisma.utils';

export interface KeyRetirementStatusResponse {
   key_id: string;
   keyId?: string;
   status: string;
   buyback_price: string | null;
   buybackPrice?: string | null;
   notice_expiry: string | null;
   noticeExpiry?: string | null;
   notice_countdown: number | null;
   noticeCountdown?: number | null;
   notice_countdown_seconds: number | null;
   reason: string | null;
}

export interface KeyRetirementHistoryItem {
   id: string;
   key_id: string;
   keyId?: string;
   event_type: string;
   eventType?: string;
   status: string;
   buyback_price: string | null;
   buybackPrice?: string | null;
   notice_expiry: string | null;
   noticeExpiry?: string | null;
   reason: string | null;
   actor: string | null;
   ledger: number;
   tx_hash: string;
   txHash?: string;
   event_index: number;
   eventIndex?: number;
   created_at: string;
   createdAt?: string;
}

/**
 * Returns the current retirement status for a key.
 *
 * If no retirement events have been recorded for the key, returns `status: "none"`.
 * Notice countdown is computed dynamically at request time from the stored notice_expiry.
 */
export async function getKeyRetirementStatus(
   keyId: string
): Promise<KeyRetirementStatusResponse> {
   const latest = await prisma.keyRetirement.findFirst({
      where: { keyId },
      orderBy: [
         { createdAt: 'desc' },
         { ledger: 'desc' },
         { eventIndex: 'desc' },
      ],
   });

   if (!latest) {
      return {
         key_id: keyId,
         keyId,
         status: 'none',
         buyback_price: null,
         buybackPrice: null,
         notice_expiry: null,
         noticeExpiry: null,
         notice_countdown: null,
         noticeCountdown: null,
         notice_countdown_seconds: null,
         reason: null,
      };
   }

   let noticeCountdown: number | null = null;
   if (latest.noticeExpiry) {
      const diffMs = latest.noticeExpiry.getTime() - Date.now();
      noticeCountdown = Math.max(0, Math.floor(diffMs / 1000));
   }

   const isoExpiry = latest.noticeExpiry
      ? latest.noticeExpiry.toISOString()
      : null;

   return {
      key_id: keyId,
      keyId,
      status: latest.status,
      buyback_price: latest.buybackPrice,
      buybackPrice: latest.buybackPrice,
      notice_expiry: isoExpiry,
      noticeExpiry: isoExpiry,
      notice_countdown: noticeCountdown,
      noticeCountdown: noticeCountdown,
      notice_countdown_seconds: noticeCountdown,
      reason: latest.reason,
   };
}

/**
 * Returns the full retirement and deprecation event history for a key.
 */
export async function getKeyRetirementHistory(
   keyId: string
): Promise<KeyRetirementHistoryItem[]> {
   const records = await prisma.keyRetirement.findMany({
      where: { keyId },
      orderBy: [
         { createdAt: 'asc' },
         { ledger: 'asc' },
         { eventIndex: 'asc' },
      ],
   });

   return records.map(r => {
      const isoExpiry = r.noticeExpiry ? r.noticeExpiry.toISOString() : null;
      const isoCreated = r.createdAt.toISOString();
      return {
         id: r.id,
         key_id: r.keyId,
         keyId: r.keyId,
         event_type: r.eventType,
         eventType: r.eventType,
         status: r.status,
         buyback_price: r.buybackPrice,
         buybackPrice: r.buybackPrice,
         notice_expiry: isoExpiry,
         noticeExpiry: isoExpiry,
         reason: r.reason,
         actor: r.actor,
         ledger: r.ledger,
         tx_hash: r.txHash,
         txHash: r.txHash,
         event_index: r.eventIndex,
         eventIndex: r.eventIndex,
         created_at: isoCreated,
         createdAt: isoCreated,
      };
   });
}
