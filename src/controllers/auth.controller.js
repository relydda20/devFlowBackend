import { User } from '../models/index.js';
import {
  buildAuthorizeUrl,
  completeCallback,
  UnsupportedProviderError,
  InvalidStateError,
  ProviderError,
} from '../services/oauth.service.js';
import { findOrCreateOAuthUser } from '../services/user-auth.service.js';
import { sign } from '../services/jwt.service.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function startOAuth(req, res, next) {
  try {
    const { provider } = req.params;
    const clientType = req.query.client_type === 'vscode' ? 'vscode' : 'web';
    const display = req.query.display === 'html' ? 'html' : null;
    const { url } = buildAuthorizeUrl({ provider, clientType, display });
    res.redirect(302, url);
  } catch (err) {
    if (err instanceof UnsupportedProviderError) {
      return res.status(400).json({ error: 'Unsupported provider' });
    }
    next(err);
  }
}

export async function oauthCallback(req, res, next) {
  try {
    const { provider } = req.params;
    const { code, state, error: providerError } = req.query;

    const result = await completeCallback({ provider, code, state, providerError });
    const user = await findOrCreateOAuthUser({
      provider,
      providerUserId: result.providerUserId,
      email: result.email,
      username: result.username,
    });
    const token = sign({ sub: user.id, provider });

    if (result.clientType === 'vscode') {
      const deepLink = `${process.env.VSCODE_DEEPLINK}?token=${encodeURIComponent(token)}`;
      return res.redirect(302, deepLink);
    }

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('session', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: SEVEN_DAYS_MS,
    });
    res.redirect(302, process.env.WEB_APP_URL);
  } catch (err) {
    if (err instanceof UnsupportedProviderError) {
      return res.status(400).json({ error: 'Unsupported provider' });
    }
    if (err instanceof InvalidStateError) {
      return res.status(400).json({ error: 'Invalid or expired state' });
    }
    if (err instanceof ProviderError) {
      return res.status(400).json({ error: 'Provider error', code: err.code });
    }
    next(err);
  }
}

export async function getMe(req, res, next) {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      provider: user.provider,
    });
  } catch (err) {
    next(err);
  }
}

export function logout(req, res) {
  res.cookie('session', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  res.status(204).end();
}
