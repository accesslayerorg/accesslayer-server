// src/modules/config/config.controllers.ts
import { Request, Response } from 'express';
import { envConfig } from '../../config';

/**
 * Public protocol configuration response shape.
 *
 * This is a lightweight bootstrap payload that clients can fetch once
 * on startup to configure themselves without hardcoding values.
 */
interface ProtocolConfig {
   /** Current deployment environment */
   environment: string;
   /** API version prefix */
   apiVersion: string;
   /** Stellar network the server targets */
   network: string;
   /** Feature flags for conditional client behaviour */
   features: {
      walletConnect: boolean;
      emailVerification: boolean;
      googleOAuth: boolean;
   };
   /** Display-related settings */
   display: {
      appName: string;
      supportEmail: string;
   };
   /**
    * Protocol fee parameters expressed in basis points (bps).
    *
    * 1 bps = 0.01%. All values are integers in the range [0, 10000].
    * Clients must treat these as read-only; they are set by the protocol
    * and change only via a contract governance action.
    */
   fees: {
      /**
       * Platform fee charged on each key purchase.
       * 250 = 2.50%. Valid range: 0–10000.
       */
      platformFeeBps: number;
      /**
       * Maximum creator royalty a creator may configure on secondary sales.
       * Creators may set any value up to this ceiling.
       * 1000 = 10.00%. Valid range: 0–10000.
       */
      maxCreatorRoyaltyBps: number;
      /**
       * Denominator used to convert a bps integer to a decimal fraction.
       * Always 10000. Included so clients can derive percentages without
       * hardcoding the divisor: `fee% = feeBps / bpsDenominator * 100`.
       */
      bpsDenominator: number;
   };
}

export const httpGetProtocolConfig = (
   _req: Request,
   res: Response
): void => {
   const config: ProtocolConfig = {
      environment: envConfig.MODE,
      apiVersion: 'v1',
      network: envConfig.MODE === 'production' ? 'mainnet' : 'testnet',
      features: {
         walletConnect: true,
         emailVerification: true,
         googleOAuth: true,
      },
      display: {
         appName: 'AccessLayer',
         supportEmail: 'support@accesslayer.org',
      },
      fees: {
         platformFeeBps: 250,
         maxCreatorRoyaltyBps: 1000,
         bpsDenominator: 10000,
      },
   };

   res.status(200).json({
      success: true,
      data: config,
   });
};
