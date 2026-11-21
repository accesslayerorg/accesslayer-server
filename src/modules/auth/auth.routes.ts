import { Router } from 'express';
import {
   httpLogin,
   httpRegisterUserWithPassword,
   httpRefreshToken,
} from './auth.controllers';
import { httpStellarChallenge } from './stellar-challenge.controller';
import { validateBody } from '../../middlewares/validate-body.middleware';
import { CreateUserWithPasswordSchema } from './auth.schemas';

const authRouter = Router();

authRouter.post('/challenge', httpStellarChallenge);
authRouter.post('/login', httpLogin);
authRouter.post(
   '/register',
   validateBody(CreateUserWithPasswordSchema),
   httpRegisterUserWithPassword
);
authRouter.post('/refresh', httpRefreshToken);

export default authRouter;
