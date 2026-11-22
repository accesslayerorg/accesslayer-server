import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-base';
import { prisma } from '../utils/prisma.utils';
import { envConfig } from '../config';

export interface AttestationRequest {
   holder: string;
   keyId: string;
}

export interface BalanceRead {
   balance: string;
   ledger: number;
}

export interface BalanceReader {
   readIndexed(holder: string, keyId: string): Promise<BalanceRead | null>;
   readRpc?(holder: string, keyId: string): Promise<BalanceRead | null>;
}

export interface AttestationKey {
   kid: string;
   publicKey: string;
}

export interface BalanceAttestation {
   holder: string;
   keyId: string;
   contractAddress: string;
   networkHash: string;
   balance: string;
   ledger: number;
   kid: string;
   expiresAt: string;
}

export interface SignedAttestation {
   payload: BalanceAttestation;
   signature: string;
}

type ConfiguredSigner = { kid: string; secret: string };

function configuredSigners(): ConfiguredSigner[] {
   const raw = process.env.STELLAR_ATTESTATION_KEYS;
   if (raw) {
      try {
         const parsed = JSON.parse(raw) as unknown;
         if (Array.isArray(parsed)) {
            const keys = parsed.filter(
               (value): value is ConfiguredSigner =>
                  !!value &&
                  typeof value === 'object' &&
                  typeof (value as ConfiguredSigner).kid === 'string' &&
                  typeof (value as ConfiguredSigner).secret === 'string'
            );
            if (keys.length) return keys;
         }
      } catch {
         // An invalid optional rotation value should not prevent the API booting.
      }
   }
   if (envConfig.STELLAR_AUTH_SECRET) {
      return [{ kid: 'default', secret: envConfig.STELLAR_AUTH_SECRET }];
   }
   return [];
}

function canonicalPayload(payload: BalanceAttestation): string {
   return JSON.stringify([
      payload.contractAddress,
      payload.networkHash,
      payload.holder,
      payload.keyId,
      payload.balance,
      payload.ledger,
      payload.kid,
      payload.expiresAt,
   ]);
}

function networkHash(): string {
   const network = envConfig.STELLAR_NETWORK === 'mainnet' ? 'PUBLIC' : 'TESTNET';
   return crypto.createHash('sha256').update(network).digest('hex');
}

export class AttestationService {
   constructor(private readonly reader: BalanceReader = defaultBalanceReader) {}

   async sign(input: AttestationRequest): Promise<SignedAttestation> {
      const signer = configuredSigners()[0];
      if (!signer) throw new Error('Attestation signing is not configured');

      const key = await prisma.registeredKey.findUnique({
         where: { keyAddress: input.keyId },
         select: { keyAddress: true },
      });
      const indexed = await this.reader.readIndexed(input.holder, input.keyId);
      if (!indexed) throw new Error('Holder balance not found');

      let balance = indexed;
      const latestLedger = Number(process.env.STELLAR_LATEST_LEDGER ?? indexed.ledger);
      if (this.reader.readRpc && latestLedger - indexed.ledger > 5) {
         balance = (await this.reader.readRpc(input.holder, input.keyId)) ?? indexed;
      }

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const payload: BalanceAttestation = {
         holder: input.holder,
         keyId: input.keyId,
         contractAddress: key?.keyAddress ?? input.keyId,
         networkHash: networkHash(),
         balance: balance.balance,
         ledger: balance.ledger,
         kid: signer.kid,
         expiresAt,
      };
      const signature = Keypair.fromSecret(signer.secret)
         .sign(Buffer.from(canonicalPayload(payload)))
         .toString('base64');
      return { payload, signature };
   }

   keys(): AttestationKey[] {
      return configuredSigners().map(({ kid, secret }) => ({
         kid,
         publicKey: Keypair.fromSecret(secret).publicKey(),
      }));
   }
}

const defaultBalanceReader: BalanceReader = {
   async readIndexed(holder, keyId) {
      const row = await prisma.walletHoldingSnapshot.findFirst({
         where: { ownerAddress: holder, creatorId: keyId },
         orderBy: { recordedAt: 'desc' },
         select: { balance: true, recordedAt: true },
      });
      if (!row) return null;
      const ledger = Number(process.env.STELLAR_INDEXED_LEDGER ?? 0);
      return { balance: row.balance.toString(), ledger };
   },
};

export const attestationService = new AttestationService();
