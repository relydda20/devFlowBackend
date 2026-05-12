import { isAdmin } from '../utils/admin.js';
import { triggerNow } from '../services/metrics-etl-scheduler.js';

export async function postRunEtl(req, res, next) {
  try {
    if (req.user?.auth_method !== 'jwt') {
      return res.status(403).json({ error: 'API tokens cannot trigger ETL' });
    }
    if (!isAdmin(req.user.id)) {
      return res.status(403).json({ error: 'Admin only' });
    }
    const outcome = await triggerNow();
    if (outcome.status === 'in_flight') {
      return res.status(409).json({ error: 'ETL pass already in flight' });
    }
    return res.json(outcome.result);
  } catch (err) {
    next(err);
  }
}
