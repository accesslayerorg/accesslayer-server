import { Router } from 'express';
import { registerAlertHandler, deleteAlertHandler } from './alert.controllers';

const router = Router();

router.post('/', registerAlertHandler);
router.delete('/:id', deleteAlertHandler);

export default router;
