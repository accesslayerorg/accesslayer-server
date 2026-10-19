// src/modules/lp/lp-rewards.contract.test.ts
import { xdr } from '@stellar/stellar-base';
import {
   getLpRewardsLive,
   LpContractNotConfiguredError,
   LpRewardsFetchError,
   buildGetLpRewardsArgs,
   decodeLpRewardsScVal,
} from './lp-rewards.contract';
import { envConfig } from '../../config';

const TEST_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TEST_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TEST_KEY = 'key-test-123';

describe('lp-rewards.contract', () => {
   describe('buildGetLpRewardsArgs', () => {
      it('builds wallet and keyId arguments as ScVals', () => {
         const [walletArg, keyIdArg] = buildGetLpRewardsArgs(TEST_WALLET, TEST_KEY);
         expect(walletArg).toBeDefined();
         expect(keyIdArg).toBeDefined();
         expect(keyIdArg.switch()).toBe(xdr.ScValType.scvString());
      });
   });

   describe('decodeLpRewardsScVal', () => {
      it('decodes u64 into decimal string preserving precision', () => {
         const scVal = xdr.ScVal.scvU64(xdr.Uint64.fromString('1234567890123456789')).toXDR('base64');
         expect(decodeLpRewardsScVal(scVal)).toBe('1234567890123456789');
      });

      it('decodes i128 into decimal string preserving precision', () => {
         const scVal = xdr.ScVal.scvI128(
            new xdr.Int128Parts({
               hi: xdr.Int64.fromString('10'),
               lo: xdr.Uint64.fromString('500'),
            })
         ).toXDR('base64');
         const expected = ((10n << 64n) | 500n).toString();
         expect(decodeLpRewardsScVal(scVal)).toBe(expected);
      });

      it('decodes u32 into decimal string', () => {
         const scVal = xdr.ScVal.scvU32(42).toXDR('base64');
         expect(decodeLpRewardsScVal(scVal)).toBe('42');
      });

      it('throws on unsupported ScValType', () => {
         const scVal = xdr.ScVal.scvSymbol('hello').toXDR('base64');
         expect(() => decodeLpRewardsScVal(scVal)).toThrow(
            'Unsupported ScValType for LP rewards'
         );
      });
   });

   describe('getLpRewardsLive', () => {
      it('returns the parsed value on success', async () => {
         const rewardScVal = xdr.ScVal.scvU64(
            xdr.Uint64.fromString('987654321000')
         ).toXDR('base64');

         const mockPostJson = jest.fn().mockResolvedValue({
            jsonrpc: '2.0',
            id: 'get-lp-rewards',
            result: {
               results: [{ retval: rewardScVal }],
            },
         });

         const result = await getLpRewardsLive(TEST_WALLET, TEST_KEY, {
            contractIdOverride: TEST_CONTRACT,
            postJson: mockPostJson,
         });

         expect(result).toBe('987654321000');
         expect(mockPostJson).toHaveBeenCalledWith(
            envConfig.STELLAR_SOROBAN_RPC_URL,
            expect.objectContaining({
               method: 'simulateTransaction',
            })
         );
      });

      it('throws LpContractNotConfiguredError when LP_CONTRACT_ID is unset', async () => {
         const saved = (envConfig as any).LP_CONTRACT_ID;
         (envConfig as any).LP_CONTRACT_ID = undefined;

         try {
            await expect(
               getLpRewardsLive(TEST_WALLET, TEST_KEY)
            ).rejects.toThrow(LpContractNotConfiguredError);
         } finally {
            (envConfig as any).LP_CONTRACT_ID = saved;
         }
      });

      it('throws LpRewardsFetchError when the RPC returns an error', async () => {
         const mockPostJson = jest.fn().mockResolvedValue({
            jsonrpc: '2.0',
            id: 'get-lp-rewards',
            error: {
               code: -32600,
               message: 'Invalid Request',
            },
         });

         await expect(
            getLpRewardsLive(TEST_WALLET, TEST_KEY, {
               contractIdOverride: TEST_CONTRACT,
               postJson: mockPostJson,
            })
         ).rejects.toThrow(LpRewardsFetchError);

         const mockNetworkFail = jest.fn().mockRejectedValue(new Error('Connection refused'));
         await expect(
            getLpRewardsLive(TEST_WALLET, TEST_KEY, {
               contractIdOverride: TEST_CONTRACT,
               postJson: mockNetworkFail,
            })
         ).rejects.toThrow(LpRewardsFetchError);
      });

      it('throws LpRewardsFetchError when the simulation result is missing or malformed', async () => {
         const mockMissing = jest.fn().mockResolvedValue({
            jsonrpc: '2.0',
            id: 'get-lp-rewards',
            result: {
               results: [],
            },
         });

         await expect(
            getLpRewardsLive(TEST_WALLET, TEST_KEY, {
               contractIdOverride: TEST_CONTRACT,
               postJson: mockMissing,
            })
         ).rejects.toThrow(LpRewardsFetchError);

         const mockMalformed = jest.fn().mockResolvedValue({
            jsonrpc: '2.0',
            id: 'get-lp-rewards',
            result: {
               results: [{ retval: 'not-valid-base64' }],
            },
         });

         await expect(
            getLpRewardsLive(TEST_WALLET, TEST_KEY, {
               contractIdOverride: TEST_CONTRACT,
               postJson: mockMalformed,
            })
         ).rejects.toThrow(LpRewardsFetchError);
      });
   });
});
