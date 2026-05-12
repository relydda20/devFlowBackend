import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { postToken, deleteToken, getTokens } from '../controllers/token.controller.js';

const router = Router();

router.post('/auth/tokens', verifyJwt, validateRequest('/auth/tokens'), postToken);
router.get('/auth/tokens', verifyJwt, getTokens);
router.delete('/auth/tokens/:id', verifyJwt, deleteToken);

export default router;
