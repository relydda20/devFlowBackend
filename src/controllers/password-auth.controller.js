import {
  registerPasswordUser,
  authenticatePasswordUser,
  EmailAlreadyRegisteredError,
} from '../services/user-auth.service.js';
import { sign } from '../services/jwt.service.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('session', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SEVEN_DAYS_MS,
  });
}

function userView(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    provider: user.provider,
  };
}

export async function register(req, res, next) {
  try {
    const { email, password, username } = req.body;
    const user = await registerPasswordUser({ email, password, username });
    const token = sign({ sub: user.id, provider: 'password' });
    setSessionCookie(res, token);
    res.status(201).json({ user: userView(user), token });
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await authenticatePasswordUser({ email, password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const token = sign({ sub: user.id, provider: 'password' });
    setSessionCookie(res, token);
    res.status(200).json({ user: userView(user), token });
  } catch (err) {
    next(err);
  }
}
