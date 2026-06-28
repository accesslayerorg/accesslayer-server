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
   /** Stellar Horizon API endpoint */
   horizonUrl: string;
   /** Stellar Soroban RPC endpoint */
   sorobanRpcUrl: string;
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
}

export const httpGetProtocolConfig = (
   _req: Request,
   res: Response
): void => {
   const config: ProtocolConfig = {
      environment: envConfig.MODE,
      apiVersion: 'v1',
      network: envConfig.STELLAR_NETWORK,
      horizonUrl: envConfig.STELLAR_HORIZON_URL,
      sorobanRpcUrl: envConfig.STELLAR_SOROBAN_RPC_URL,
      features: {
         walletConnect: true,
         emailVerification: true,
         googleOAuth: true,
      },
      display: {
         appName: 'AccessLayer',
         supportEmail: 'support@accesslayer.org',
      },
   };

   res.status(200).json({
      success: true,
      data: config,
   });
};

