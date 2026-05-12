import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.middleware.js';
import { getChurnHandler, getContextSwitchingHandler } from '../controllers/metrics.controller.js';
import { postRunEtl } from '../controllers/metrics-etl.controller.js';

const router = Router();

router.get('/metrics/churn', verifyJwt, getChurnHandler);
router.get('/metrics/context-switching', verifyJwt, getContextSwitchingHandler);
router.post('/metrics/etl/run', verifyJwt, postRunEtl);

export default router;
