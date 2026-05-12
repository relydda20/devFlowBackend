import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { startOAuth, oauthCallback, getMe, logout } from '../controllers/auth.controller.js';
import { register, login } from '../controllers/password-auth.controller.js';

const router = Router();

router.post('/auth/register', validateRequest('/auth/register'), register);
router.post('/auth/login', validateRequest('/auth/login'), login);
router.get('/auth/me', verifyJwt, getMe);
router.post('/auth/logout', logout);
router.get('/auth/:provider', startOAuth);
router.get('/auth/:provider/callback', oauthCallback);

export default router;
