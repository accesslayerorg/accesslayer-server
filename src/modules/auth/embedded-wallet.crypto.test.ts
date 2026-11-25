// src/modules/auth/embedded-wallet.crypto.test.ts

import {
   encryptWalletSecret,
   decryptWalletSecret,
   setSecretsManagerProvider,
} from './embedded-wallet.crypto';

describe('embedded-wallet.crypto', () => {
   afterEach(() => {
      setSecretsManagerProvider(null);
   });

   it('encrypts and decrypts a Stellar secret key using secrets manager key', async () => {
      setSecretsManagerProvider({
         getWalletMasterKey: () => 'test-secrets-manager-master-key-32bytes',
      });

      const secret = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';
      const encrypted = await encryptWalletSecret(secret);

      expect(encrypted).not.toContain(secret);
      expect(encrypted.startsWith('v1:')).toBe(true);

      const decrypted = await decryptWalletSecret(encrypted);
      expect(decrypted).toBe(secret);
   });

   it('produces distinct ciphertexts for the same plaintext due to random IVs', async () => {
      setSecretsManagerProvider({
         getWalletMasterKey: () => 'another-test-master-key-for-iv-check',
      });

      const secret = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';
      const first = await encryptWalletSecret(secret);
      const second = await encryptWalletSecret(secret);

      expect(first).not.toBe(second);
      expect(await decryptWalletSecret(first)).toBe(secret);
      expect(await decryptWalletSecret(second)).toBe(secret);
   });

   it('rejects tampered ciphertext', async () => {
      setSecretsManagerProvider({
         getWalletMasterKey: () => 'tamper-check-master-key-1234567890',
      });

      const encrypted = await encryptWalletSecret('SABC1234567890');
      const parts = encrypted.split(':');
      parts[3] = 'ff'.repeat(parts[3].length / 2);

      await expect(decryptWalletSecret(parts.join(':'))).rejects.toThrow();
   });
});
