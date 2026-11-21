import { logger } from '../../utils/logger.utils';

export interface DeprecateGateway {
   deprecateKey(input: {
      creatorId: string;
      buybackPricePerKey: number;
      circulatingSupply: number;
   }): Promise<{ transactionHash?: string }>;
}

export const deprecateGateway: DeprecateGateway = {
   async deprecateKey(input) {
      logger.info(
         {
            operation: 'deprecate_key_contract_call',
            keyId: input.creatorId,
            buybackPricePerKey: input.buybackPricePerKey,
            circulatingSupply: input.circulatingSupply,
         },
         'Submitting deprecate_key contract call'
      );
      return { transactionHash: undefined };
   },
};
