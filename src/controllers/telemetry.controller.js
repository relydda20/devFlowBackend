import { ingestBatch, UserNotFoundError } from '../services/telemetry.service.js';

export async function submitTelemetry(req, res, next) {
  try {
    const { accepted_count } = await ingestBatch(req.body);
    res.status(202).json({ message: 'Telemetry accepted', accepted_count });
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return res.status(404).json({ error: 'User not found' });
    }
    next(err);
  }
}
