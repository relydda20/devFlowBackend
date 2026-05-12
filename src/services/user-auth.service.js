import crypto from 'crypto';
import { User } from '../models/index.js';
import { hash, verify, normalizeEmail } from './password.service.js';

export class EmailAlreadyRegisteredError extends Error {
  constructor(email) {
    super(`Email already registered: ${email}`);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

async function pickUsername(base, provider, providerUserId) {
  const candidates = [
    base,
    `${provider}-${providerUserId.slice(0, 8)}`,
    `${provider}-${providerUserId.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate.slice(0, 50);
    const collision = await User.findOne({ where: { username: trimmed } });
    if (!collision) return trimmed;
  }
  return `${provider}-${crypto.randomBytes(6).toString('hex')}`;
}

export async function findOrCreateOAuthUser({ provider, providerUserId, email, username }) {
  const existing = await User.findOne({ where: { provider, provider_user_id: providerUserId } });
  if (existing) return existing;

  const finalUsername = await pickUsername(username || `${provider}-${providerUserId.slice(0, 8)}`, provider, providerUserId);
  return User.create({
    provider,
    provider_user_id: providerUserId,
    email,
    username: finalUsername,
  });
}

export async function registerPasswordUser({ email, password, username }) {
  const normalized = normalizeEmail(email);
  const existing = await User.findOne({
    where: { provider: 'password', provider_user_id: normalized },
  });
  if (existing) throw new EmailAlreadyRegisteredError(normalized);

  const base = username || normalized.split('@')[0];
  const finalUsername = await pickUsername(base, 'password', normalized);
  const password_hash = await hash(password);

  return User.create({
    provider: 'password',
    provider_user_id: normalized,
    email: normalized,
    username: finalUsername,
    password_hash,
  });
}

export async function authenticatePasswordUser({ email, password }) {
  const normalized = normalizeEmail(email);
  const user = await User.findOne({
    where: { provider: 'password', provider_user_id: normalized },
  });
  if (!user || !user.password_hash) return null;
  const ok = await verify(password, user.password_hash);
  return ok ? user : null;
}
