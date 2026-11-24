// src/modules/auth/passkey.service.test.ts

jest.mock('@simplewebauthn/server', () => ({
   generateRegistrationOptions: jest.fn(),
   verifyRegistrationResponse: jest.fn(),
   generateAuthenticationOptions: jest.fn(),
   verifyAuthenticationResponse: jest.fn(),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      passkeyCredential: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         findFirst: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      embeddedWallet: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
      user: {
         findUnique: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

jest.mock('../../utils/jwt.utils', () => ({
   signWalletAccessToken: jest.fn(() => 'mock-jwt-token'),
}));

jest.mock('../../utils/mail.utils', () => ({
   SendMail: jest.fn(async () => true),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import {
   generateRegistrationOptions,
   verifyRegistrationResponse,
   generateAuthenticationOptions,
   verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { Keypair, Networks, TransactionBuilder, Operation, Asset } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { SendMail } from '../../utils/mail.utils';
import {
   setSecretsManagerProvider,
   encryptWalletSecret,
} from './embedded-wallet.crypto';
import {
   PASSKEY_CHALLENGE_TTL_SECONDS,
   createPasskeyRegistrationOptions,
   verifyPasskeyRegistration,
   createPasskeyLoginOptions,
   verifyPasskeyLogin,
   signWithEmbeddedWallet,
   requestEmbeddedWalletExportConfirmation,
   exportEmbeddedWallet,
   PasskeyServiceError,
} from './passkey.service';

const mockPrisma = prisma as unknown as {
   passkeyCredential: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
   };
   embeddedWallet: {
      findUnique: jest.Mock;
      create: jest.Mock;
   };
   user: {
      findUnique: jest.Mock;
   };
};

describe('passkey.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      setSecretsManagerProvider({
         getWalletMasterKey: () => 'unit-test-master-key-32-chars-minimum',
      });
   });

   afterEach(() => {
      setSecretsManagerProvider(null);
   });

   describe('registration', () => {
      it('stores registration challenge in Redis for 5 minutes', async () => {
         mockPrisma.passkeyCredential.findMany.mockResolvedValue([]);
         (generateRegistrationOptions as jest.Mock).mockResolvedValue({
            challenge: 'reg-challenge-1',
            rp: { name: 'AccessLayer', id: 'localhost' },
         });

         const result = await createPasskeyRegistrationOptions({
            userId: 'user-1',
            email: 'alice@example.com',
            origin: 'http://localhost:3000',
         });

         expect(result.options.challenge).toBe('reg-challenge-1');
         expect(cacheSetJson).toHaveBeenCalledWith(
            'passkey:challenge:register:user-1',
            expect.objectContaining({
               challenge: 'reg-challenge-1',
               userId: 'user-1',
               expectedOrigin: 'http://localhost:3000',
            }),
            PASSKEY_CHALLENGE_TTL_SECONDS
         );
         expect(PASSKEY_CHALLENGE_TTL_SECONDS).toBe(300);
      });

      it('verifies registration, creates credential and encrypted embedded wallet', async () => {
         (cacheGetJson as jest.Mock).mockResolvedValue({
            challenge: 'reg-challenge-1',
            userId: 'user-1',
            expectedOrigin: 'http://localhost:3000',
            expectedRPID: 'localhost',
            createdAt: Date.now(),
         });
         (verifyRegistrationResponse as jest.Mock).mockResolvedValue({
            verified: true,
            registrationInfo: {
               credential: {
                  id: 'cred-1',
                  publicKey: new Uint8Array([1, 2, 3, 4]),
                  counter: 0,
               },
               credentialDeviceType: 'singleDevice',
               credentialBackedUp: false,
            },
         });
         mockPrisma.passkeyCredential.create.mockResolvedValue({ id: 'pk-1' });
         mockPrisma.embeddedWallet.findUnique.mockResolvedValue(null);
         mockPrisma.embeddedWallet.create.mockImplementation(async ({ data }) => ({
            id: 'ew-1',
            userId: data.userId,
            publicKey: data.publicKey,
            createdAt: new Date(),
         }));

         const res = await verifyPasskeyRegistration({
            userId: 'user-1',
            origin: 'http://localhost:3000',
            response: {
               id: 'cred-1',
               rawId: 'cred-1',
               type: 'public-key',
               response: {
                  clientDataJSON: 'abc',
                  attestationObject: 'def',
                  transports: ['internal'],
               },
               clientExtensionResults: {},
            } as any,
         });

         expect(res.verified).toBe(true);
         expect(res.accessToken).toBe('mock-jwt-token');
         expect(res.wallet.publicKey).toMatch(/^G/);
         expect((res.wallet as any).encryptedSecret).toBeUndefined();
         expect(mockPrisma.embeddedWallet.create).toHaveBeenCalledWith(
            expect.objectContaining({
               data: expect.objectContaining({
                  userId: 'user-1',
                  encryptedSecret: expect.stringMatching(/^v1:/),
               }),
            })
         );
         expect(cacheInvalidate).toHaveBeenCalledWith(
            'passkey:challenge:register:user-1'
         );
      });
   });

   describe('login', () => {
      it('validates signature counter and origin on login verify', async () => {
         (generateAuthenticationOptions as jest.Mock).mockResolvedValue({
            challenge: 'login-challenge-1',
         });
         await createPasskeyLoginOptions({
            userId: 'user-1',
            origin: 'http://localhost:3000',
         });
         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringMatching(/^passkey:challenge:login:/),
            expect.objectContaining({ challenge: 'login-challenge-1' }),
            300
         );

         (cacheGetJson as jest.Mock).mockResolvedValue({
            challenge: 'login-challenge-1',
            userId: 'user-1',
            expectedOrigin: 'http://localhost:3000',
            expectedRPID: 'localhost',
            createdAt: Date.now(),
         });
         mockPrisma.passkeyCredential.findUnique.mockResolvedValue({
            id: 'pk-1',
            userId: 'user-1',
            credentialId: 'cred-1',
            publicKey: Buffer.from([1, 2, 3, 4]).toString('base64url'),
            counter: 5,
            transports: ['internal'],
         });
         (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
            verified: true,
            authenticationInfo: { newCounter: 5 }, // replay! counter did not advance
         });

         await expect(
            verifyPasskeyLogin({
               challengeId: 'c-1',
               origin: 'http://localhost:3000',
               response: { id: 'cred-1', response: {} } as any,
            })
         ).rejects.toMatchObject({
            statusCode: 401,
            code: 'COUNTER_REPLAY_DETECTED',
         });
      });

      it('rejects login when origin does not match allowed origins', async () => {
         (cacheGetJson as jest.Mock).mockResolvedValue({
            challenge: 'login-challenge-2',
            userId: 'user-1',
            expectedOrigin: 'http://localhost:3000',
            expectedRPID: 'localhost',
            createdAt: Date.now(),
         });
         mockPrisma.passkeyCredential.findUnique.mockResolvedValue({
            id: 'pk-1',
            userId: 'user-1',
            credentialId: 'cred-1',
            publicKey: Buffer.from([1, 2, 3, 4]).toString('base64url'),
            counter: 1,
            transports: [],
         });

         await expect(
            verifyPasskeyLogin({
               challengeId: 'c-2',
               origin: 'https://evil.example.com',
               response: { id: 'cred-1', response: {} } as any,
            })
         ).rejects.toMatchObject({
            statusCode: 403,
            code: 'INVALID_ORIGIN',
         });
      });
   });

   describe('embedded wallet sign & export', () => {
      it('requires recent passkey assertion for amounts above threshold and signs below threshold', async () => {
         const kp = Keypair.random();
         const encryptedSecret = await encryptWalletSecret(kp.secret());
         mockPrisma.embeddedWallet.findUnique.mockResolvedValue({
            id: 'ew-1',
            userId: 'user-1',
            publicKey: kp.publicKey(),
            encryptedSecret,
         });
         mockPrisma.passkeyCredential.findFirst.mockResolvedValue(null);

         const tx = new TransactionBuilder(
            {
               accountId: () => kp.publicKey(),
               sequenceNumber: () => '1',
               incrementSequenceNumber: () => {},
            } as any,
            { fee: '100', networkPassphrase: Networks.TESTNET }
         )
            .addOperation(
               Operation.payment({
                  destination: Keypair.random().publicKey(),
                  asset: Asset.native(),
                  amount: '10',
               })
            )
            .setTimeout(30)
            .build();
         const xdr = tx.toXDR();

         // Above default threshold (100) without recent assertion -> 403
         await expect(
            signWithEmbeddedWallet({
               walletAddress: kp.publicKey(),
               transactionXdr: xdr,
               amount: 250,
            })
         ).rejects.toMatchObject({
            statusCode: 403,
            code: 'PASSKEY_ASSERTION_REQUIRED',
         });

         // Below threshold (50) -> succeeds
         const signed = await signWithEmbeddedWallet({
            walletAddress: kp.publicKey(),
            transactionXdr: xdr,
            amount: 50,
         });
         expect(signed.publicKey).toBe(kp.publicKey());
         expect(signed.signedXdr).toBeTruthy();
      });

      it('requires fresh assertion and email confirmation for export', async () => {
         const kp = Keypair.random();
         const encryptedSecret = await encryptWalletSecret(kp.secret());
         mockPrisma.embeddedWallet.findUnique.mockResolvedValue({
            id: 'ew-1',
            userId: 'user-1',
            publicKey: kp.publicKey(),
            encryptedSecret,
         });
         mockPrisma.user.findUnique.mockResolvedValue({
            email: 'alice@example.com',
         });

         await requestEmbeddedWalletExportConfirmation({
            walletAddress: kp.publicKey(),
         });
         expect(SendMail).toHaveBeenCalledTimes(1);

         // Fresh assertion present, invalid email code -> 403
         mockPrisma.passkeyCredential.findFirst.mockResolvedValue({ id: 'pk-1' });
         (cacheGetJson as jest.Mock).mockResolvedValue(null);

         await expect(
            exportEmbeddedWallet({
               walletAddress: kp.publicKey(),
               emailConfirmationCode: '000000',
            })
         ).rejects.toBeInstanceOf(PasskeyServiceError);
      });
   });
});
