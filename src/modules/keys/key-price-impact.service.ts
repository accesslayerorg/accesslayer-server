// src/modules/keys/key-price-impact.service.ts
import {
   Contract,
   nativeToScVal,
   scValToNative,
   xdr,
   TransactionBuilder,
   Account,
   Networks,
} from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import {
   buyCost,
   sellProceeds,
   spotPrice,
   validateMilestones,
   Milestone,
} from '../../utils/bonding-curve.utils';
import {
   defaultSorobanTransport,
   SorobanPostJson,
} from '../../clients/soroban.client';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface PriceImpactResponse {
   estimated_output: string;
   price_impact_bps: number;
   fee_amount: string;
   net_received: string;
}

export type OnChainPriceImpactFetcher = (
   contractId: string,
   amount: number,
   direction: 'buy' | 'sell'
) => Promise<PriceImpactResponse | null>;

let customFetcher: OnChainPriceImpactFetcher | null = null;

/**
 * Configure a custom on-chain price impact fetcher (used for unit/integration testing).
 */
export function setOnChainPriceImpactFetcher(
   fetcher: OnChainPriceImpactFetcher | null
): void {
   customFetcher = fetcher;
}

/**
 * Builds and simulates a call to the bonding curve contract's get_price_impact view function.
 * Fetches live state directly from Soroban RPC with no caching.
 */
export async function callContractPriceImpact(
   contractId: string,
   amount: number,
   direction: 'buy' | 'sell',
   postJson: SorobanPostJson = defaultSorobanTransport
): Promise<PriceImpactResponse | null> {
   if (!envConfig.STELLAR_SOROBAN_RPC_URL) {
      return null;
   }

   const isContractAddress = /^C[A-Z2-7]{55}$/.test(contractId);
   if (!isContractAddress) {
      return null;
   }

   const networkPassphrase =
      envConfig.STELLAR_NETWORK === 'mainnet'
         ? Networks.PUBLIC
         : Networks.TESTNET;

   const dummySourceAccount =
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

   try {
      const contract = new Contract(contractId);
      const operation = contract.call(
         'get_price_impact',
         nativeToScVal(BigInt(amount)),
         xdr.ScVal.scvSymbol(direction)
      );

      const tx = new TransactionBuilder(new Account(dummySourceAccount, '0'), {
         fee: '100',
         networkPassphrase,
      })
         .addOperation(operation)
         .setTimeout(300)
         .build();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 250);

      try {
         const response = (await postJson(envConfig.STELLAR_SOROBAN_RPC_URL, {
            jsonrpc: '2.0',
            id: 'get-price-impact',
            method: 'simulateTransaction',
            params: {
               transaction: tx.toXDR(),
            },
         })) as {
            error?: { code: number; message: string };
            result?: {
               results?: Array<{ xdr?: string; retval?: string }>;
            };
         };

         if (!response || response.error) {
            logger.debug(
               { error: response?.error, contractId, amount, direction },
               'Soroban simulateTransaction returned error for get_price_impact'
            );
            return null;
         }

         const returnedXdr =
            response.result?.results?.[0]?.retval ??
            response.result?.results?.[0]?.xdr;

         if (!returnedXdr) {
            return null;
         }

         const scVal = xdr.ScVal.fromXDR(returnedXdr, 'base64');
         const native = scValToNative(scVal) as any;

         if (!native) {
            return null;
         }

         if (Array.isArray(native)) {
            const [
               estimated_output,
               price_impact_bps,
               fee_amount,
               net_received,
            ] = native;
            return {
               estimated_output: estimated_output?.toString() ?? '0',
               price_impact_bps: Number(price_impact_bps ?? 0),
               fee_amount: fee_amount?.toString() ?? '0',
               net_received: net_received?.toString() ?? '0',
            };
         }

         if (typeof native === 'object') {
            const estimated_output =
               native.estimated_output ?? native.estimatedOutput;
            const price_impact_bps =
               native.price_impact_bps ?? native.priceImpactBps;
            const fee_amount = native.fee_amount ?? native.feeAmount;
            const net_received = native.net_received ?? native.netReceived;

            return {
               estimated_output: estimated_output?.toString() ?? '0',
               price_impact_bps: Number(price_impact_bps ?? 0),
               fee_amount: fee_amount?.toString() ?? '0',
               net_received: net_received?.toString() ?? '0',
            };
         }

         return null;
      } finally {
         clearTimeout(timeout);
      }
   } catch (error) {
      logger.debug(
         { error: (error as Error).message, contractId, amount, direction },
         'Failed to call contract get_price_impact via RPC'
      );
      return null;
   }
}

/**
 * Resolves a key identifier (cuid, keyAddress, or handle) to its contract ID and creator details.
 */
export async function resolveKeyDetails(keyId: string): Promise<{
   contractId: string | null;
   creator: any;
   currentSupply: number;
   milestones: Milestone[];
   baseExponent: number;
}> {
   const isContractAddress = /^C[A-Z2-7]{55}$/.test(keyId);

   // Try CreatorProfile first (by id, handle, or keyAddress if matched)
   let creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
   });

   // Try RegisteredKey
   const registeredKey = await prisma.registeredKey.findFirst({
      where: {
         OR: [{ id: keyId }, { keyAddress: keyId }, { handle: keyId }],
      },
   });

   if (!creator && registeredKey) {
      creator = await prisma.creatorProfile.findFirst({
         where: {
            OR: [
               { id: registeredKey.id },
               { handle: registeredKey.handle ?? '' },
            ],
         },
      });
   }

   if (!creator && !registeredKey && !isContractAddress) {
      throw new KeyNotFoundError(keyId);
   }

   const contractId =
      registeredKey?.keyAddress ?? (isContractAddress ? keyId : null);

   const currentSupply = creator ? Number(creator.circulatingSupply) : 0;
   const milestones = creator
      ? validateMilestones((creator as any).curveMilestones ?? [])
      : [];
   const rawExp = creator ? (creator as any).baseExponent : 1;
   const baseExponent =
      typeof rawExp === 'number' && Number.isInteger(rawExp) && rawExp >= 0
         ? rawExp
         : 1;

   return {
      contractId,
      creator,
      currentSupply,
      milestones,
      baseExponent,
   };
}

/**
 * Calculates price impact, estimated output, fee amount, and net received
 * directly from current database on-chain supply and piecewise bonding curve math.
 */
export async function calculatePriceImpactOffChain(
   keyId: string,
   amount: number,
   direction: 'buy' | 'sell',
   resolvedKeyDetails?: {
      contractId: string | null;
      creator: any;
      currentSupply: number;
      milestones: Milestone[];
      baseExponent: number;
   }
): Promise<PriceImpactResponse> {
   const { creator, currentSupply, milestones, baseExponent } =
      resolvedKeyDetails ?? (await resolveKeyDetails(keyId));

   if (direction === 'sell' && amount > currentSupply) {
      throw new Error('Cannot sell more keys than current supply');
   }

   // Load fee configuration (protocol fee + royalty bps, default 500 = 5%)
   let feeBps = 500;
   try {
      const protocolConfig = await prisma.protocolConfig.findFirst({
         where: { id: 'default' },
      });
      const protocolFeeBps = protocolConfig?.protocolFeeBps ?? 500;
      const royaltyBps =
         direction === 'buy'
            ? (creator?.creatorRoyaltyBuyBps ?? 0)
            : (creator?.creatorRoyaltySellBps ?? 0);
      feeBps = protocolFeeBps + royaltyBps;
   } catch {
      if (creator) {
         const royalty =
            direction === 'buy'
               ? (creator.creatorRoyaltyBuyBps ?? 0)
               : (creator.creatorRoyaltySellBps ?? 0);
         feeBps = royalty + 500;
      }
   }
   if (feeBps <= 0) feeBps = 500;

   const currentSpot = spotPrice(currentSupply, milestones, baseExponent);

   let estimated_output: bigint;
   let fee_amount: bigint;
   let net_received: bigint;
   let price_impact_bps = 0;

   if (direction === 'buy') {
      const grossCost = buyCost(
         currentSupply,
         amount,
         milestones,
         baseExponent
      );
      estimated_output = grossCost;
      fee_amount = (grossCost * BigInt(feeBps)) / 10000n;
      net_received = grossCost + fee_amount;

      const avgPrice = amount > 0 ? grossCost / BigInt(amount) : currentSpot;
      if (currentSpot > 0n && avgPrice > currentSpot) {
         price_impact_bps = Math.round(
            Number((avgPrice - currentSpot) * 10000n) / Number(currentSpot)
         );
      }
   } else {
      const grossProceeds = sellProceeds(
         currentSupply,
         amount,
         milestones,
         baseExponent
      );
      estimated_output = grossProceeds;
      fee_amount = (grossProceeds * BigInt(feeBps)) / 10000n;
      net_received = grossProceeds - fee_amount;

      const avgPrice =
         amount > 0 ? grossProceeds / BigInt(amount) : currentSpot;
      if (currentSpot > 0n && currentSpot > avgPrice) {
         price_impact_bps = Math.round(
            Number((currentSpot - avgPrice) * 10000n) / Number(currentSpot)
         );
      }
   }

   return {
      estimated_output: estimated_output.toString(),
      price_impact_bps,
      fee_amount: fee_amount.toString(),
      net_received: net_received.toString(),
   };
}

/**
 * Calculates price impact estimation for a frontend swap preview.
 *
 * Calls the bonding curve's get_price_impact view function on-chain.
 * Always fetches live from RPC with no caching to ensure accuracy.
 *
 * @param keyId - The creator key ID, handle, or contract address
 * @param amount - Number of keys to swap
 * @param direction - 'buy' or 'sell'
 * @returns Estimated output, price impact in bps, fee amount, and net received
 */
export async function getPriceImpact(
   keyId: string,
   amount: number,
   direction: 'buy' | 'sell'
): Promise<PriceImpactResponse> {
   if (amount <= 0 || !Number.isFinite(amount)) {
      throw new Error('Amount must be greater than 0');
   }

   if (direction !== 'buy' && direction !== 'sell') {
      throw new Error('Direction must be "buy" or "sell"');
   }

   const resolved = await resolveKeyDetails(keyId);
   const { contractId } = resolved;

   // 1. Check custom on-chain fetcher if injected (e.g. in test suite)
   if (customFetcher && contractId) {
      const customResult = await customFetcher(contractId, amount, direction);
      if (customResult) {
         return customResult;
      }
   }

   // 2. Fetch live from Soroban RPC (never cached)
   if (contractId) {
      const onChainResult = await callContractPriceImpact(
         contractId,
         amount,
         direction
      );
      if (onChainResult) {
         return onChainResult;
      }
   }

   // 3. Fallback to accurate off-chain bonding curve calculation
   return calculatePriceImpactOffChain(keyId, amount, direction, resolved);
}
