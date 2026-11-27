import { Router } from 'express';
import {
   httpLogin,
   httpRegisterUserWithPassword,
   httpRefreshToken,
} from './auth.controllers';
import { httpStellarChallenge } from './stellar-challenge.controller';
import { validateBody } from '../../middlewares/validate-body.middleware';
import { CreateUserWithPasswordSchema } from './auth.schemas';
import passkeyRouter from './passkey.routes';

const authRouter = Router();

authRouter.post('/challenge', httpStellarChallenge);
authRouter.post('/login', httpLogin);
authRouter.post(
   '/register',
   validateBody(CreateUserWithPasswordSchema),
   httpRegisterUserWithPassword
);
authRouter.post('/refresh', httpRefreshToken);
authRouter.use('/passkey', passkeyRouter);

export default authRouter;
