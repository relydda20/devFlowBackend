import { Router } from 'express';
import { validateRequest } from '../middleware/validation.middleware.js';
import { submitTelemetry } from '../controllers/telemetry.controller.js';

const router = Router();

router.post('/telemetry', validateRequest('/telemetry'), submitTelemetry);

export default router;
