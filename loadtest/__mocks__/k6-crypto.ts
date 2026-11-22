import crypto from 'crypto';

const k6Crypto = {
   hmac: (
      algorithm: string,
      secret: string,
      message: string,
      outputEncoding: string
   ): string => {
      if (outputEncoding === 'base64rawurl') {
         return crypto
            .createHmac(algorithm, secret)
            .update(message)
            .digest('base64url');
      }
      return crypto
         .createHmac(algorithm, secret)
         .update(message)
         .digest(outputEncoding as any);
   },
};

export default k6Crypto;
