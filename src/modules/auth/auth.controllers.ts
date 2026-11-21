import { CreateUserWithPasswordType } from './auth.schemas';
import { AsyncController } from '../../types/auth.types';
import { checkUserEmailExists, createNewUserWithPassword } from './auth.utils';
import { SendMailAsync } from '../../utils/mail.utils';
import { HTTP_STATUS, logger } from '../../utils/logger.utils';
import bcrypt from 'bcrypt';
import { refreshAccessToken } from './token-refresh.utils';
import { buildErrorResponse, ErrorCode } from '../../utils/api-response.utils';

export const httpRegisterUserWithPassword: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      // Body is already validated and stripped of unknown fields by the
      // validateBody(CreateUserWithPasswordSchema) middleware on this route.
      const validatedUserDetails = req.body as CreateUserWithPasswordType;

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
      logger.error({ error, requestId: req.requestId }, 'Failed to register user');
      next(error);
   }
};

export const httpLogin: AsyncController = async (req, res, next) => {
   try {
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      logger.error({ error, requestId: req.requestId }, 'Login failed');
      next(error);
   }
};

export const httpLogout: AsyncController = async (req, res, next) => {
   try {
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      logger.error({ error, requestId: req.requestId }, 'Logout failed');
      next(error);
   }
};

export const httpUpdateProfile: AsyncController = async (req, res, next) => {
   try {
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      logger.error(
         { error, requestId: req.requestId },
         'Failed to update profile'
      );
      next(error);
   }
};

export const httpVerifyEmail: AsyncController = async (req, res, next) => {
   try {
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      logger.error(
         { error, requestId: req.requestId },
         'Failed to verify email'
      );
      next(error);
   }
};

export const httpResetPassword: AsyncController = async (req, res, next) => {
   try {
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      logger.error(
         { error, requestId: req.requestId },
         'Failed to reset password'
      );
      next(error);
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
         return res
            .status(HTTP_STATUS.UNAUTHORIZED)
            .json(
               buildErrorResponse(ErrorCode.JWT_ERROR, 'No token provided', [
                  { message: 'invalid_token' },
               ])
            );
      }

      const result = refreshAccessToken(token);

      if (!result.success) {
         return res
            .status(result.status)
            .json(
               buildErrorResponse(
                  ErrorCode.JWT_ERROR,
                  'Token could not be refreshed',
                  [{ message: result.code }]
               )
            );
      }

      return res.status(HTTP_STATUS.OK).json({
         success: true,
         message: 'Token refreshed',
         data: {
            accessToken: result.token,
         },
      });
   } catch (error) {
      logger.error(
         { error, requestId: req.requestId },
         'Failed to refresh token'
      );
      next(error);
   }
};

export const httpGetProfile: AsyncController = async (req, res, next) => {
   try {
      res.status(200).json({
         success: true,
         message: 'Login Successful',
         data: {
            name: 'Anioke Sebastian',
            age: 23,
         },
      });
   } catch (error) {
      logger.error({ error, requestId: req.requestId }, 'Failed to get profile');
      next(error);
   }
};
