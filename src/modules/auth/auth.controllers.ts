import { CreateUserWithPasswordSchema } from './auth.schemas';
import { AsyncController } from '../../types/auth.types';
import { checkUserEmailExists, createNewUserWithPassword } from './auth.utils';
import { SendMailAsync } from '../../utils/mail.utils';
import { HTTP_STATUS } from '../../utils/logger.utils';
import bcrypt from 'bcrypt';
import { refreshAccessToken } from './token-refresh.utils';
import {
   Keypair,
   Account,
   TransactionBuilder,
   Networks,
   Operation,
   Memo,
} from '@stellar/stellar-base';
import { randomBytes } from 'crypto';
import { isValidStellarAddress } from '../wallet/wallet.utils';
import { buildValidationError } from '../../utils/validation-error.utils';
import { sendSuccess } from '../../utils/api-response.utils';
import { envConfig } from '../../config';

export const httpRegisterUserWithPassword: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const validatedUserDetails = CreateUserWithPasswordSchema.parse(req.body);

      const emailExists = await checkUserEmailExists(
         validatedUserDetails.email
      );

      if (emailExists) {
         SendMailAsync({
            to: validatedUserDetails.email,
            subject: 'Someone tried to sign up with your email',
            text: 'If this was you, log in here. Otherwise, ignore this.',
         });
         return res.status(HTTP_STATUS.CREATED).json({
            success: false,
            message: 'Check your email to continue',
         });
      }
      const passwordHash = await bcrypt.hash(validatedUserDetails.password, 12);

      const newUser = await createNewUserWithPassword({
         ...validatedUserDetails,
         passwordHash,
      });

      return res.status(HTTP_STATUS.CREATED).json({
         success: true,
         message: 'Login Successful',
         data: {
            user: newUser,
            tokens: {
               accessToken: '4q4qtwerg',
               refreshToken: 'erotqhaerog',
            },
         },
      });
   } catch (error) {
      console.log(error);
      next(error);
   }
};

export const httpLogin: AsyncController = async (req, res, next) => {
   try {
      console.log(req);
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      next(error);
      console.log(error);
   }
};

export const httpLogout: AsyncController = async (req, res, next) => {
   try {
      console.log(req);
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      next(error);
      console.log(error);
   }
};

export const httpUpdateProfile: AsyncController = async (req, res, next) => {
   try {
      console.log(req);
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      next(error);
      console.log(error);
   }
};

export const httpVerifyEmail: AsyncController = async (req, res, next) => {
   try {
      console.log(req);
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      next(error);
      console.log(error);
   }
};

export const httpResetPassword: AsyncController = async (req, res, next) => {
   try {
      console.log(req);
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      next(error);
      console.log(error);
   }
};

export const httpRefreshToken: AsyncController = async (req, res, next) => {
   try {
      const authHeader = req.headers.authorization;
      const token =
         (authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length)
            : undefined) ?? req.body?.token;

      if (!token) {
         return res.status(HTTP_STATUS.UNAUTHORIZED).json({
            success: false,
            code: 'invalid_token',
            message: 'No token provided',
         });
      }

      const result = refreshAccessToken(token);

      if (!result.success) {
         return res.status(result.status).json({
            success: false,
            code: result.code,
            message: 'Token could not be refreshed',
         });
      }

      return res.status(HTTP_STATUS.OK).json({
         success: true,
         message: 'Token refreshed',
         data: {
            accessToken: result.token,
         },
      });
   } catch (error) {
      next(error);
      console.log(error);
   }
};

export const httpGetProfile: AsyncController = async (req, res, next) => {
   try {
      console.log(req);
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      next(error);
      console.log(error);
   }
};

const DEFAULT_SERVER_KEYPAIR = Keypair.random();

export const httpWalletChallenge: AsyncController = async (req, res, next) => {
   try {
      const rawAddress =
         req.body?.address ??
         req.body?.wallet_address ??
         req.body?.walletAddress;
      const address = typeof rawAddress === 'string' ? rawAddress.trim() : '';

      if (!address || !isValidStellarAddress(address)) {
         return res
            .status(422)
            .json(
               buildValidationError(
                  'address',
                  'Invalid Stellar wallet address',
                  'INVALID_ADDRESS'
               )
            );
      }

      const serverSecret = process.env.STELLAR_SERVER_SECRET_KEY;
      const serverKeypair = serverSecret
         ? Keypair.fromSecret(serverSecret)
         : DEFAULT_SERVER_KEYPAIR;

      const networkPassphrase =
         envConfig.STELLAR_NETWORK === 'mainnet'
            ? Networks.PUBLIC
            : Networks.TESTNET;

      const serverAccount = new Account(serverKeypair.publicKey(), '0');
      const nonce = randomBytes(14).toString('hex');
      const domain = process.env.WEB_AUTH_DOMAIN || 'accesslayer.org';

      const tx = new TransactionBuilder(serverAccount, {
         fee: '100',
         networkPassphrase,
         timebounds: {
            minTime: Math.floor(Date.now() / 1000),
            maxTime: Math.floor(Date.now() / 1000) + 300,
         },
         memo: Memo.text(nonce),
      })
         .addOperation(
            Operation.manageData({
               name: 'web_auth_domain',
               value: domain,
               source: address,
            })
         )
         .build();

      tx.sign(serverKeypair);
      const xdr = tx.toXDR();

      return sendSuccess(res, { transaction: xdr });
   } catch (error) {
      next(error);
   }
};
