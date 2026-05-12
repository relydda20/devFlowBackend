import jwt from 'jsonwebtoken';
import { verify } from '../services/jwt.service.js';
import { verifyToken, touchLastUsed } from '../services/api-token.service.js';

const API_TOKEN_PREFIX = 'dvf_';

function unauthorized(res) {
  return res.status(401).json({ error: 'Unauthorized' });
}

export async function verifyJwt(req, res, next) {
  let token;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  } else if (req.cookies?.session) {
    token = req.cookies.session;
  }

  if (!token) return unauthorized(res);

  if (token.startsWith(API_TOKEN_PREFIX)) {
    try {
      const result = await verifyToken(token);
      if (!result) return unauthorized(res);
      req.user = { id: result.user_id, auth_method: 'api_token', token_id: result.token_id };
      touchLastUsed(result.token_id);
      return next();
    } catch {
      return unauthorized(res);
    }
  }

  try {
    const payload = verify(token);
    req.user = { id: payload.sub, provider: payload.provider, auth_method: 'jwt' };
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return unauthorized(res);
    return unauthorized(res);
  }
}
