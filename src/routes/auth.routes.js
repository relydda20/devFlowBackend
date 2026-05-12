import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.middleware.js';
import { startOAuth, oauthCallback, getMe, logout } from '../controllers/auth.controller.js';

const router = Router();

router.get('/auth/me', verifyJwt, getMe);
router.post('/auth/logout', logout);
router.get('/auth/:provider', startOAuth);
router.get('/auth/:provider/callback', oauthCallback);

export default router;
