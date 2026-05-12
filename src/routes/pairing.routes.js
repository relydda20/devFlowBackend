import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.middleware.js';
import { postPairing, postApprove, postExchange } from '../controllers/pairing.controller.js';

const router = Router();

router.post('/auth/pairings', postPairing);
router.post('/auth/pairings/:user_code/approve', verifyJwt, postApprove);
router.post('/auth/pairings/:pairing_id/exchange', postExchange);

export default router;
