import { Router } from 'express';
import { httpSubmitContractCall } from './contract.controllers';

const contractsRouter = Router();

// Centralised Soroban contract interaction service (#899). All on-chain
// submissions (buy, sell, stake, governance, claim) are routed through this
// endpoint so retry, classification, tracking, and resolution events are
// applied uniformly.
contractsRouter.post('/call', httpSubmitContractCall);

export default contractsRouter;
