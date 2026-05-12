import { issueToken, revokeToken, listTokens } from '../services/api-token.service.js';

function requireJwtUser(req, res) {
  if (req.user?.auth_method !== 'jwt') {
    res.status(403).json({ error: 'API tokens cannot manage other tokens' });
    return false;
  }
  return true;
}

export async function postToken(req, res, next) {
  if (!requireJwtUser(req, res)) return;
  try {
    const { name } = req.body;
    const issued = await issueToken(req.user.id, name);
    res.status(201).json(issued);
  } catch (err) {
    next(err);
  }
}

export async function deleteToken(req, res, next) {
  if (!requireJwtUser(req, res)) return;
  try {
    const ok = await revokeToken(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Token not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function getTokens(req, res, next) {
  if (!requireJwtUser(req, res)) return;
  try {
    const tokens = await listTokens(req.user.id);
    res.json({ tokens });
  } catch (err) {
    next(err);
  }
}
