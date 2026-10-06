// src/modules/keys/key-registration.service.test.ts
import {
   registerKeyContract,
   validateKeyAddressOnChain,
   DuplicateKeyRegistrationError,
   InvalidOnChainContractError,
   keyEventEmitter,
} from './key-registration.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      registeredKey: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
   },
}));

jest.mock('../../utils/soroban-rpc.utils', () => ({
   getLedgerEntries: jest.fn(),
}));

jest.mock('../../utils/audit.utils', () => ({
   emitAuditEvent: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { getLedgerEntries } from '../../utils/soroban-rpc.utils';
import { emitAuditEvent } from '../../utils/audit.utils';

const mockRegisteredKeyFindUnique = prisma.registeredKey.findUnique as jest.Mock;
const mockRegisteredKeyCreate = prisma.registeredKey.create as jest.Mock;
const mockGetLedgerEntries = getLedgerEntries as jest.Mock;
const mockEmitAuditEvent = emitAuditEvent as jest.Mock;

const VALID_CONTRACT = 'CCW67TSB3SSS33333333333333333333333333333333333333333333';
const VALID_STELLAR_WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK7';

describe('Key Registration Service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('validateKeyAddressOnChain', () => {
      it('returns true for valid Stellar address format', async () => {
         const valid = await validateKeyAddressOnChain(VALID_STELLAR_WALLET);
         expect(valid).toBe(true);
      });

      it('returns false for invalid address string', async () => {
         expect(await validateKeyAddressOnChain('invalid-address')).toBe(false);
         expect(await validateKeyAddressOnChain('')).toBe(false);
      });

      it('returns false when Soroban RPC returns no entries for a contract ID', async () => {
         mockGetLedgerEntries.mockResolvedValue({ entries: [], latestLedger: 100 });
         const valid = await validateKeyAddressOnChain(VALID_CONTRACT);
         expect(valid).toBe(false);
      });
   });

   describe('registerKeyContract', () => {
      it('throws InvalidOnChainContractError when contract address is invalid', async () => {
         await expect(
            registerKeyContract({
               keyAddress: 'invalid_address',
               creatorWallet: VALID_STELLAR_WALLET,
            })
         ).rejects.toThrow(InvalidOnChainContractError);
      });

      it('throws DuplicateKeyRegistrationError when key address is already registered', async () => {
         mockGetLedgerEntries.mockResolvedValue({
            entries: [{ key: 'k', xdr: 'x', lastModifiedLedgerSeq: 1 }],
            latestLedger: 100,
         });
         mockRegisteredKeyFindUnique.mockResolvedValue({
            id: 'rk_1',
            keyAddress: VALID_CONTRACT,
         });

         await expect(
            registerKeyContract({
               keyAddress: VALID_CONTRACT,
               creatorWallet: VALID_STELLAR_WALLET,
            })
         ).rejects.toThrow(DuplicateKeyRegistrationError);
      });

      it('stores key metadata in DB and emits key_registered event upon successful registration', async () => {
         mockGetLedgerEntries.mockResolvedValue({
            entries: [{ key: 'k', xdr: 'x', lastModifiedLedgerSeq: 1 }],
            latestLedger: 100,
         });
         mockRegisteredKeyFindUnique.mockResolvedValue(null);

         const createdRecord = {
            id: 'rk_123',
            keyAddress: VALID_CONTRACT,
            creatorWallet: VALID_STELLAR_WALLET,
            handle: 'testcreator',
            displayName: 'Test Creator',
            metadata: { feeTier: 'standard' },
            status: 'ACTIVE',
            createdAt: new Date(),
            updatedAt: new Date(),
         };
         mockRegisteredKeyCreate.mockResolvedValue(createdRecord);

         const eventListener = jest.fn();
         keyEventEmitter.on('key_registered', eventListener);

         const result = await registerKeyContract({
            keyAddress: VALID_CONTRACT,
            creatorWallet: VALID_STELLAR_WALLET,
            handle: 'testcreator',
            displayName: 'Test Creator',
            metadata: { feeTier: 'standard' },
         });

         expect(result).toEqual(createdRecord);
         expect(mockRegisteredKeyCreate).toHaveBeenCalledWith({
            data: {
               keyAddress: VALID_CONTRACT,
               creatorWallet: VALID_STELLAR_WALLET,
               handle: 'testcreator',
               displayName: 'Test Creator',
               metadata: { feeTier: 'standard' },
               status: 'ACTIVE',
            },
         });

         expect(mockEmitAuditEvent).toHaveBeenCalledWith({
            actor: VALID_STELLAR_WALLET,
            action: 'key_registered',
            target: 'CreatorKey',
            targetId: VALID_CONTRACT,
            metadata: { feeTier: 'standard' },
         });

         expect(eventListener).toHaveBeenCalledWith(
            expect.objectContaining({
               event: 'key_registered',
               keyAddress: VALID_CONTRACT,
               creatorWallet: VALID_STELLAR_WALLET,
            })
         );
      });
   });
});
