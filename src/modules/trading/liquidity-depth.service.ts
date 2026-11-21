import {
   Account,
   Contract,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { horizonGet } from '../../clients/horizon.client';
import { prisma } from '../../utils/prisma.utils';

const DEPTH_CACHE_TTL_MS = 10_000;
const depthCache = new Map<
   string,
   { value: Promise<bigint>; expiresAt: number }
>();

export type DepthSide = 'buy' | 'sell';

export class LiquidityDepthUnavailableError extends Error {
   constructor(message = 'On-chain liquidity depth is unavailable') {
      super(message);
      this.name = 'LiquidityDepthUnavailableError';
   }
}

async function resolveContractId(keyIdentifier: string): Promise<string> {
   const registered = await prisma.registeredKey.findFirst({
      where: {
         OR: [
            { id: keyIdentifier },
            { keyAddress: keyIdentifier },
            { handle: keyIdentifier },
         ],
      },
      select: { keyAddress: true },
   });
   const metadata = registered
      ? null
      : await prisma.keyMetadata.findFirst({
           where: { OR: [{ keyId: keyIdentifier }, { keyAddress: keyIdentifier }] },
           select: { keyAddress: true },
        });
   const contractId =
      registered?.keyAddress ??
      metadata?.keyAddress ??
      (/^C[A-Z2-7]{55}$/.test(keyIdentifier) ? keyIdentifier : null);
   if (!contractId) throw new LiquidityDepthUnavailableError('No contract is registered for this key');
   return contractId;
}

async function getSequence(wallet: string): Promise<string> {
   const response = await horizonGet(`/accounts/${encodeURIComponent(wallet)}`);
   if (!response.ok) throw new LiquidityDepthUnavailableError('Unable to load the wallet sequence');
   const account = (await response.json()) as { sequence?: unknown };
   if (typeof account.sequence !== 'string' || !/^\d+$/.test(account.sequence)) {
      throw new LiquidityDepthUnavailableError('Horizon returned an invalid wallet sequence');
   }
   return account.sequence;
}

function decodeIntegerScVal(value: string): bigint {
   let scVal: xdr.ScVal;
   try {
      scVal = xdr.ScVal.fromXDR(value, 'base64');
   } catch {
      throw new LiquidityDepthUnavailableError('Contract returned an invalid depth value');
   }
   const type = scVal.switch();
   if (type === xdr.ScValType.scvU32()) return BigInt(scVal.u32());
   if (type === xdr.ScValType.scvI32()) return BigInt(scVal.i32());
   if (type === xdr.ScValType.scvU64()) return BigInt(scVal.u64().toString());
   if (type === xdr.ScValType.scvI64()) return BigInt(scVal.i64().toString());
   if (type === xdr.ScValType.scvU128() || type === xdr.ScValType.scvI128()) {
      const parts = type === xdr.ScValType.scvU128() ? scVal.u128() : scVal.i128();
      return (
         (BigInt(parts.hi().toString()) << 64n) |
         BigInt.asUintN(64, BigInt(parts.lo().toString()))
      );
   }
   throw new LiquidityDepthUnavailableError('Contract returned a non-integer depth value');
}

/** Read a key contract's `get_max_buy` / `get_max_sell` view with a short cache. */
export async function getMaxAvailableDepth(
   wallet: string,
   keyIdentifier: string,
   side: DepthSide,
   now = Date.now()
): Promise<bigint> {
   const contractId = await resolveContractId(keyIdentifier);
   const cacheKey = `${contractId}:${wallet}:${side}`;
   const cached = depthCache.get(cacheKey);
   if (cached && cached.expiresAt > now) return cached.value;
   if (cached) depthCache.delete(cacheKey);

   const value = (async () => {
      const sequence = await getSequence(wallet);
      const operation = new Contract(contractId).call(
         side === 'buy' ? 'get_max_buy' : 'get_max_sell'
      );
      const transaction = new TransactionBuilder(new Account(wallet, sequence), {
         fee: '100',
         networkPassphrase:
            envConfig.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
      })
         .addOperation(operation)
         .setTimeout(300)
         .build()
         .toXDR();

      let response: Response;
      try {
         response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
               jsonrpc: '2.0',
               id: 'liquidity-depth',
               method: 'simulateTransaction',
               params: { transaction },
            }),
         });
      } catch {
         throw new LiquidityDepthUnavailableError();
      }
      if (!response.ok) throw new LiquidityDepthUnavailableError();
      const envelope = (await response.json()) as {
         error?: { message?: string };
         result?: { results?: Array<{ retval?: string }> };
      };
      const resultXdr = envelope.result?.results?.[0]?.retval;
      if (envelope.error || !resultXdr) throw new LiquidityDepthUnavailableError();

      const result = decodeIntegerScVal(resultXdr);
      if (result < 0n) {
         throw new LiquidityDepthUnavailableError('Contract returned negative liquidity depth');
      }
      return result;
   })();
   const entry = { value, expiresAt: now + DEPTH_CACHE_TTL_MS };
   depthCache.set(cacheKey, entry);
   try {
      return await value;
   } catch (error) {
      if (depthCache.get(cacheKey) === entry) depthCache.delete(cacheKey);
      throw error;
   }
}

export function clearLiquidityDepthCache(): void {
   depthCache.clear();
}
