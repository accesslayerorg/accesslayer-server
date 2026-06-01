import { Router } from 'express';
import { httpGetLedgerStatus } from './ledger.controllers';

const ledgerRouter = Router();

/**
 * GET /api/v1/ledger/status
 * 
 * Public read-only endpoint for ledger sync state.
 */
ledgerRouter.get('/status', httpGetLedgerStatus);

export default ledgerRouter;
