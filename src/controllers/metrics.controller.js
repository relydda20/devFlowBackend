import { getChurn, getContextSwitching } from '../services/metrics.service.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseRange(req, res) {
  const { from, to, grain } = req.query;
  if (!from || !to) {
    res.status(400).json({ error: 'Validation failed', message: 'from and to are required (YYYY-MM-DD)' });
    return null;
  }
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    res.status(400).json({ error: 'Validation failed', message: 'from and to must be YYYY-MM-DD' });
    return null;
  }
  if (from > to) {
    res.status(400).json({ error: 'Validation failed', message: 'from must be <= to' });
    return null;
  }
  const resolvedGrain = grain === 'session' ? 'session' : 'daily';
  return { from, to, grain: resolvedGrain };
}

export async function getChurnHandler(req, res, next) {
  try {
    const parsed = parseRange(req, res);
    if (!parsed) return;
    const result = await getChurn({ userId: req.user.id, ...parsed });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getContextSwitchingHandler(req, res, next) {
  try {
    const parsed = parseRange(req, res);
    if (!parsed) return;

    let topN = 10;
    if (req.query.top_n !== undefined) {
      const raw = Number(req.query.top_n);
      if (!Number.isInteger(raw) || raw < 1 || raw > 20) {
        return res.status(400).json({ error: 'Validation failed', message: 'top_n must be an integer 1..20' });
      }
      topN = raw;
    }

    const result = await getContextSwitching({ userId: req.user.id, ...parsed, topN });
    res.json(result);
  } catch (err) {
    next(err);
  }
}
