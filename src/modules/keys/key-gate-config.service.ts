// src/modules/keys/key-gate-config.service.ts
// Business logic for GET /keys/:keyId/gate (#1150).

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { envConfig } from '../../config';
import { keyGateConfigRedisKey } from '../../constants/redis.constants';
import {
   fetchGateConfigFromContract,
   type GateType,
} from './key-gate-config-contract';

export interface GateConfigResponse {
   gateType: GateType | null;
   requirementParams: Record<string, unknown>;
   isGated: boolean;
}

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

/**
 * Get gate configuration for a key.
 * Data fetched from contract call with caching (60s).
 * Returns is_gated false if no gate configured.
 */
export async function getGateConfig(
   keyId: string,
   _now: Date = new Date()
): Promise<GateConfigResponse> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const cacheKey = keyGateConfigRedisKey(creator.id);
   const cached = await cacheGetJson<GateConfigResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const config = await fetchGateConfigFromContract(creator.id);
   const result: GateConfigResponse = config
      ? {
           gateType: config.gateType,
           requirementParams: config.requirementParams,
           isGated: true,
        }
      : {
           gateType: null,
           requirementParams: {},
           isGated: false,
        };

   await cacheSetJson(
      cacheKey,
      result,
      envConfig.GATE_CONFIG_CACHE_TTL_SECONDS
   );

   return result;
}
