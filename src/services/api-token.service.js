import crypto from 'crypto';
import { ApiToken, User } from '../models/index.js';
import logger from '../utils/logger.js';

const TOKEN_PREFIX = 'dvf_';
const SECRET_BYTES = 32;
const PREFIX_LENGTH = 6;

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

export async function issueToken(user_id, name) {
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const token_hash = hashSecret(secret);
  const token_prefix = secret.slice(0, PREFIX_LENGTH);

  const row = await ApiToken.create({
    user_id,
    name,
    token_hash,
    token_prefix,
  });

  return {
    id: row.id,
    name: row.name,
    token: `${TOKEN_PREFIX}${secret}`,
    token_prefix,
    created_at: row.created_at,
  };
}

export async function verifyToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const secret = rawToken.slice(TOKEN_PREFIX.length);
  if (secret.length === 0) return null;

  const token_hash = hashSecret(secret);

  const row = await ApiToken.findOne({
    where: { token_hash, revoked_at: null },
    include: [{ model: User, required: true }],
  });

  if (!row) return null;

  // Constant-time guard against any prefix-leakage in lookup paths.
  const expected = Buffer.from(row.token_hash, 'hex');
  const actual = Buffer.from(token_hash, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }

  return { token_id: row.id, user_id: row.user_id, user: row.User };
}

export function touchLastUsed(token_id) {
  // Fire-and-forget; failures are logged but do not block the request.
  ApiToken.update({ last_used_at: new Date() }, { where: { id: token_id } })
    .catch((err) => logger.warn('Failed to update api_token.last_used_at', { error: err.message, token_id }));
}

export async function revokeToken(user_id, token_id) {
  const [count] = await ApiToken.update(
    { revoked_at: new Date() },
    { where: { id: token_id, user_id, revoked_at: null } }
  );
  return count > 0;
}

export async function listTokens(user_id) {
  const rows = await ApiToken.findAll({
    where: { user_id },
    order: [['created_at', 'DESC']],
    attributes: ['id', 'name', 'token_prefix', 'last_used_at', 'created_at', 'revoked_at'],
  });
  return rows.map((r) => r.toJSON());
}
