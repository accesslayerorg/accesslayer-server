import { Router } from 'express';
import { httpSubmitContractCall } from './contract.controllers';
import { httpGetContractReceived } from './callback-transfer.controller';

const contractsRouter = Router();

// Centralised Soroban contract interaction service (#899). All on-chain
// submissions (buy, sell, stake, governance, claim) are routed through this
// endpoint so retry, classification, tracking, and resolution events are
// applied uniformly.
contractsRouter.post('/call', httpSubmitContractCall);
// GET /api/v1/contracts/:address/received — callback transfers received
// by a contract (#1274).
contractsRouter.get('/:address/received', httpGetContractReceived);

export default contractsRouter;
