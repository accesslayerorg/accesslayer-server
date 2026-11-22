import { Prisma } from '@prisma/client';
import { StrKey } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { IndexerChainEvent, processIndexerChainEvents } from '../../utils/indexer-event-processor.utils';
import { invalidateCampaignCache } from '../campaigns/campaign-read.service';

const CREATED = new Set(['CampaignCreated', 'CAMPAIGN_CREATED', 'campaign_created', 'camp_new']);
const QUALIFIED = new Set(['WalletQualified', 'WALLET_QUALIFIED', 'wallet_qualified', 'qual']);
const CLAIMED = new Set(['RewardClaimed', 'REWARD_CLAIMED', 'reward_claimed', 'claim']);
export const CAMPAIGN_EVENT_TYPES: ReadonlySet<string> = new Set([...CREATED, ...QUALIFIED, ...CLAIMED]);

type CampaignTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type Position = { ledger: number; eventIndex: number; txHash: string };
type BaseEvent = Position & { campaignId: string; occurredAt: Date };
type Created = BaseEvent & {
   type: 'created'; name: string; description?: string; criteriaType: string;
   threshold: string; criteria?: Prisma.InputJsonObject; rewardPool: string;
   startDate: Date; endDate: Date; contractAddress?: string;
};
type Qualified = BaseEvent & {
   type: 'qualified'; wallet: string; score: string; totalScore: string;
   criteriaProgress?: Prisma.InputJsonObject;
};
type Claimed = BaseEvent & { type: 'claimed'; wallet: string; amount: string };
type CampaignChainEvent = Created | Qualified | Claimed;
type ParseResult = { ok: true; value: CampaignChainEvent } | { ok: false; reason: string };

function text(value: unknown): string | undefined {
   return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
      ? value.trim() : undefined;
}

function decimal(value: unknown): string | null {
   if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
   if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return null;
   if (!/^(?:0|[1-9][0-9]{0,38})$/.test(String(value))) return null;
   const amount = BigInt(value);
   return amount <= (1n << 127n) - 1n ? amount.toString() : null;
}

function campaignIdentifier(value: unknown): string | undefined {
   if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined;
   if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return undefined;
   if (!/^(?:0|[1-9][0-9]{0,19})$/.test(String(value))) return undefined;
   const id = BigInt(value);
   return id <= (1n << 64n) - 1n ? id.toString() : undefined;
}

/** Generic short topics belong here only when they carry campaign identity. */
export function isCampaignEvent(event: IndexerChainEvent): boolean {
   return CAMPAIGN_EVENT_TYPES.has(event.eventType)
      && (!['camp_new', 'qual', 'claim'].includes(event.eventType)
         || event.campaign_id !== undefined || event.campaignId !== undefined);
}

function criterion(value: unknown): string | undefined {
   const name = typeof value === 'string' ? value
      : Array.isArray(value) ? text(value[0])
      : value && typeof value === 'object' ? Object.keys(value)[0] : undefined;
   return name === 'Volume' ? 'TRADE_VOLUME'
      : name === 'Trades' ? 'TRADE_COUNT'
      : name === 'HoldDays' ? 'HOLD_DAYS'
      : ['TRADE_VOLUME', 'TRADE_COUNT', 'HOLD_DAYS', 'ACTIVITY_COUNT'].includes(name ?? '') ? name : undefined;
}

function date(value: unknown): Date | null {
   if (typeof value !== 'number' && typeof value !== 'string' && !(value instanceof Date) && typeof value !== 'bigint') return null;
   if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
   const numeric = typeof value === 'bigint' ? Number(value)
      : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
   const parsed = typeof numeric === 'number' ? new Date(numeric * 1000) : new Date(numeric as string);
   return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function jsonObject(value: unknown): Prisma.InputJsonObject | undefined {
   if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
   return JSON.parse(JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
   )) as Prisma.InputJsonObject;
}

export function parseCampaignEvent(event: IndexerChainEvent): ParseResult {
   const raw = event as Record<string, unknown>;
   const campaignId = campaignIdentifier(raw.campaignId ?? raw.campaign_id);
   const ledger = Number(raw.ledger);
   const eventIndex = Number(raw.eventIndex);
   const validPositionValue = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v));
   const txHash = text(raw.txHash);
   if (!campaignId || !txHash || !validPositionValue(raw.ledger) || !validPositionValue(raw.eventIndex)
      || !Number.isInteger(ledger) || ledger < 0 || ledger > 2147483647
      || !Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex > 2147483647) {
      return { ok: false, reason: 'Invalid campaign id or chain position' };
   }
   const occurredAt = date(raw.timestamp ?? raw.occurredAt ?? raw.occurred_at) ?? new Date();
   const base = { campaignId, ledger, eventIndex, txHash, occurredAt };
   if (CREATED.has(event.eventType)) {
      const startDate = date(raw.startDate ?? raw.start_date ?? raw.startTime ?? raw.start_time);
      const endDate = date(raw.endDate ?? raw.end_date ?? raw.endTime ?? raw.end_time);
      const keyId = text(raw.key_id ?? raw.keyId);
      const criteria = jsonObject(raw.criteria) ?? (keyId ? { keyId } : undefined);
      const threshold = decimal(raw.threshold ?? criteria?.threshold);
      const rewardPool = decimal(raw.rewardPool ?? raw.reward_pool);
      const criteriaType = criterion(raw.criterion ?? raw.criteriaType ?? raw.criteria_type ?? criteria?.kind ?? criteria?.type);
      if (!startDate || !endDate || endDate <= startDate || !criteriaType || threshold === null || rewardPool === null) {
         return { ok: false, reason: 'Invalid campaign dates, threshold or reward pool' };
      }
      return { ok: true, value: {
         ...base, type: 'created', name: text(raw.name) ?? 'Campaign ' + campaignId,
         description: text(raw.description), criteriaType, threshold, criteria,
         rewardPool, startDate, endDate, contractAddress: text(raw.contractId ?? raw.contractAddress ?? raw.contract_address),
      } };
   }
   const wallet = text(raw.wallet ?? raw.recipient ?? raw.claimant);
   if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
      return { ok: false, reason: 'Invalid campaign wallet' };
   }
   if (QUALIFIED.has(event.eventType)) {
      const score = decimal(raw.score ?? raw.criteriaScore ?? raw.criteria_score ?? raw.metricValue ?? raw.metric_value ?? '0');
      const totalScore = decimal(raw.totalScore ?? raw.total_score);
      if (score === null || totalScore === null || BigInt(score) <= 0n || BigInt(totalScore) < BigInt(score)) return { ok: false, reason: 'Invalid qualification score or cumulative total' };
      return { ok: true, value: {
         ...base, type: 'qualified', wallet, score, totalScore,
         criteriaProgress: jsonObject(raw.criteriaProgress ?? raw.criteria_progress),
      } };
   }
   if (CLAIMED.has(event.eventType)) {
      const amount = decimal(raw.amount ?? raw.rewardAmount ?? raw.reward_amount);
      if (amount === null) return { ok: false, reason: 'Invalid claimed reward amount' };
      return { ok: true, value: { ...base, type: 'claimed', wallet, amount } };
   }
   return { ok: false, reason: 'Unsupported campaign event' };
}

function newer(value: Position, row: { ledger: number | null; eventIndex: number | null; txHash: string | null } | null): boolean {
   if (row?.ledger === null || row?.ledger === undefined) return true;
   if (value.ledger !== row.ledger) return value.ledger > row.ledger;
   if (value.eventIndex !== row.eventIndex) return value.eventIndex > (row.eventIndex ?? -1);
   return value.txHash > (row.txHash ?? '');
}

async function applyCampaignEvent(tx: CampaignTransactionClient, value: CampaignChainEvent): Promise<boolean> {
   // All events for one campaign serialize, including claims delivered before creation.
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'campaign:' + value.campaignId}, 0))`;
   const eventKey = { txHash_eventIndex: { txHash: value.txHash, eventIndex: value.eventIndex } };
   if (await tx.campaignEvent.findUnique({ where: eventKey })) return false;
   await tx.campaignEvent.create({ data: {
      campaignId: value.campaignId, type: value.type,
      wallet: value.type === 'created' ? null : value.wallet,
      ledger: value.ledger, eventIndex: value.eventIndex, txHash: value.txHash,
      occurredAt: value.occurredAt,
      totalScore: value.type === 'qualified' ? value.totalScore : null,
      payload: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
   } });
   if (value.type === 'created') {
      const current = await tx.campaign.findUnique({ where: { id: value.campaignId } });
      if (!newer(value, current)) return true;
      const fields = {
         name: value.name, description: value.description, criteriaType: value.criteriaType,
         threshold: value.threshold, criteria: value.criteria,
         rewardPool: value.rewardPool, startDate: value.startDate, endDate: value.endDate,
         contractAddress: value.contractAddress,
         ledger: value.ledger, eventIndex: value.eventIndex, txHash: value.txHash,
      };
      await tx.campaign.upsert({
         where: { id: value.campaignId },
         create: { id: value.campaignId, ...fields }, update: fields,
      });
      return true;
   }
   const where = { campaignId_wallet: { campaignId: value.campaignId, wallet: value.wallet } };
   if (value.type === 'claimed') {
      await tx.campaignEligibility.upsert({
         where,
         create: { campaignId: value.campaignId, wallet: value.wallet, eligible: false, claimed: true, claimedAmount: value.amount },
         update: { claimed: true, claimedAmount: { increment: value.amount } },
      });
      return true;
   }
   const current = await tx.campaignEligibility.findUnique({ where });
   if (!newer(value, current)) return true;
   const fields = {
      eligible: true, score: value.score,
      criteriaProgress: value.criteriaProgress, qualifiedAt: value.occurredAt,
      ledger: value.ledger, eventIndex: value.eventIndex, txHash: value.txHash,
   };
   await tx.campaignEligibility.upsert({
      where, create: { campaignId: value.campaignId, wallet: value.wallet, ...fields }, update: fields,
   });
   return true;
}

export async function processCampaignEvent(event: IndexerChainEvent): Promise<boolean> {
   const parsed = parseCampaignEvent(event);
   if (!parsed.ok) {
      logger.warn({ eventId: event.txHash + ':' + event.eventIndex, reason: parsed.reason }, 'Campaign event moved to DLQ');
      await moveToDLQ({
         jobType: 'CAMPAIGN', payload: JSON.parse(JSON.stringify(event, (_key, item) =>
            typeof item === 'bigint' ? item.toString() : item
         )), retryCount: 0, failureReason: parsed.reason,
      });
      return false;
   }
   let applied = false;
   try {
      applied = await prisma.$transaction(tx => applyCampaignEvent(tx, parsed.value));
   } catch (error) {
      const replay = (error as { code?: string })?.code === 'P2002'
         && await prisma.campaignEvent.findUnique({ where: {
            txHash_eventIndex: { txHash: parsed.value.txHash, eventIndex: parsed.value.eventIndex },
         } });
      if (!replay) throw error;
   }
   // Replays also invalidate, so a failed post-commit cache operation is repairable.
   await invalidateCampaignCache(parsed.value.campaignId);
   return applied;
}

export async function processCampaignEvents(events: IndexerChainEvent[]): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isCampaignEvent(event)) return;
      await processCampaignEvent(event);
   });
}
