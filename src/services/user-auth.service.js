import crypto from 'crypto';
import { User } from '../models/index.js';

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
