import {
  createPairing,
  approvePairing,
  exchangePairing,
  APPROVE_ERRORS,
  EXCHANGE_STATUS,
} from '../services/pairing.service.js';

const USER_CODE_RE = /^[BCDFGHJKMNPQRSTVWXZ23456789]{4}-[BCDFGHJKMNPQRSTVWXZ23456789]{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RATE_LIMIT_WINDOW_MS = 1000;
const exchangeLastAt = new Map();

export function resetLimiter() {
  exchangeLastAt.clear();
}

function rateLimit(pairingId) {
  const now = Date.now();
  const last = exchangeLastAt.get(pairingId);
  if (last && now - last < RATE_LIMIT_WINDOW_MS) return false;
  exchangeLastAt.set(pairingId, now);
  return true;
}

export async function postPairing(req, res, next) {
  try {
    const result = await createPairing();
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function postApprove(req, res, next) {
  if (req.user?.auth_method !== 'jwt') {
    return res.status(403).json({ error: 'API tokens cannot approve pairings' });
  }

  const { user_code } = req.params;
  if (!USER_CODE_RE.test(user_code)) {
    return res.status(404).json({ error: 'Pairing not found or expired' });
  }

  try {
    const result = await approvePairing(user_code, req.user.id);
    if (result.error === APPROVE_ERRORS.NOT_FOUND) {
      return res.status(404).json({ error: 'Pairing not found or expired' });
    }
    if (result.error === APPROVE_ERRORS.EXPIRED) {
      return res.status(410).json({ error: 'Pairing expired' });
    }
    if (result.error === APPROVE_ERRORS.ALREADY_USED) {
      return res.status(409).json({ error: 'Pairing already used' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function postExchange(req, res, next) {
  const { pairing_id } = req.params;
  if (!UUID_RE.test(pairing_id)) {
    return res.status(410).json({ status: EXCHANGE_STATUS.EXPIRED });
  }

  if (!rateLimit(pairing_id)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const result = await exchangePairing(pairing_id);
    if (result.status === EXCHANGE_STATUS.EXPIRED) {
      return res.status(410).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
