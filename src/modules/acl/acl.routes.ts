// src/modules/acl/acl.routes.ts
// Admin routes for on-chain ACL whitelist management (#966). Mounted at
// /admin/acl by admin.routes.ts. Every route requires a valid admin JWT
// (adminGuard).

import { Router } from 'express';
import { adminGuard } from '../../middlewares/admin-guard.middleware';
import {
   httpListAcl,
   httpAddAcl,
   httpRemoveAcl,
   httpGetAclHistory,
} from './acl.controllers';

const aclRouter = Router();

/** GET /admin/acl/history - add/remove event log with actor and timestamp. */
aclRouter.get('/history', adminGuard, httpGetAclHistory);

/** GET /admin/acl - paginated list of whitelisted contracts. */
aclRouter.get('/', adminGuard, httpListAcl);

/** POST /admin/acl - add a contract + permitted functions to the ACL. */
aclRouter.post('/', adminGuard, httpAddAcl);

/** DELETE /admin/acl/:contractId - remove a contract from the ACL. */
aclRouter.delete('/:contractId', adminGuard, httpRemoveAcl);

export default aclRouter;
