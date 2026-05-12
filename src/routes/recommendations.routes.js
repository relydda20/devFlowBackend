import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.middleware.js';
import {
  getPending,
  getRecent,
  postAction,
} from '../controllers/recommendations.controller.js';

const router = Router();

router.get('/recommendations/pending', verifyJwt, getPending);
router.get('/recommendations', verifyJwt, getRecent);
router.post('/recommendations/:id/action', verifyJwt, postAction);

export default router;
