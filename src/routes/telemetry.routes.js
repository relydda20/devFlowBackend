import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { submitTelemetry } from '../controllers/telemetry.controller.js';

const router = Router();

router.post('/telemetry', verifyJwt, validateRequest('/telemetry'), submitTelemetry);

export default router;
