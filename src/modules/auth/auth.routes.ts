import { Router } from 'express';
import {
   httpLogin,
   httpRegisterUserWithPassword,
   httpRefreshToken,
   httpWalletChallenge,
} from './auth.controllers';

const authRouter = Router();

authRouter.post('/login', httpLogin);
authRouter.post('/register', httpRegisterUserWithPassword);
authRouter.post('/refresh', httpRefreshToken);
authRouter.post('/challenge', httpWalletChallenge);

export default authRouter;
