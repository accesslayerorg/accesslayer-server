import { Router } from 'express';
import { httpUpdateCreatorMetadata, httpReplayIndexerEvents } from './admin.controllers';
import { adminGuard } from '../../middlewares/admin-guard.middleware';

const adminRouter = Router();

adminRouter.patch('/creators/:id/metadata', httpUpdateCreatorMetadata);
adminRouter.post('/indexer/replay', adminGuard, httpReplayIndexerEvents);

export default adminRouter;
