import crypto from 'crypto';
import { Op } from 'sequelize';
import { PairingCode } from '../models/index.js';
import { sequelize } from '../config/database.js';
import { issueToken } from './api-token.service.js';
import logger from '../utils/logger.js';

const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';
const USER_CODE_HALF = 4;
const TTL_SECONDS = 600;
const CLEANUP_GRACE_SECONDS = 3600;

export function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'https://who-goes-to-try.hackathon.sev-2.com').replace(/\/+$/, '');
}

export function generateUserCode() {
  const pickChar = () => USER_CODE_ALPHABET[crypto.randomInt(0, USER_CODE_ALPHABET.length)];
  const half = () => Array.from({ length: USER_CODE_HALF }, pickChar).join('');
  return `${half()}-${half()}`;
}

export async function createPairing() {
  const expires_at = new Date(Date.now() + TTL_SECONDS * 1000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const user_code = generateUserCode();
    try {
      const row = await PairingCode.create({ user_code, status: 'pending', expires_at });
      logger.info('pairing: created', { pairing_id: row.id });
      return {
        pairing_id: row.id,
        user_code: row.user_code,
        verification_uri: `${getFrontendUrl()}/extension/pair`,
        expires_in: TTL_SECONDS,
      };
    } catch (err) {
      if (err?.name === 'SequelizeUniqueConstraintError') continue;
      throw err;
    }
  }
  throw new Error('Failed to allocate a unique pairing code');
}

export const APPROVE_ERRORS = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  EXPIRED: 'EXPIRED',
  ALREADY_USED: 'ALREADY_USED',
});

export async function approvePairing(userCode, userId) {
  return sequelize.transaction(async (t) => {
    const row = await PairingCode.findOne({
      where: { user_code: userCode },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!row) return { error: APPROVE_ERRORS.NOT_FOUND };

    if (row.expires_at < new Date()) {
      await row.destroy({ transaction: t });
      return { error: APPROVE_ERRORS.EXPIRED };
    }

    if (row.status !== 'pending') {
      return { error: APPROVE_ERRORS.ALREADY_USED };
    }

    const today = new Date().toISOString().slice(0, 10);
    const issued = await issueToken(userId, `VSCode (paired ${today})`);

    row.status = 'approved';
    row.user_id = userId;
    row.api_token_id = issued.id;
    row.token_plaintext = issued.token;
    await row.save({ transaction: t });

    logger.info('pairing: approved', {
      pairing_id: row.id,
      user_id: userId,
      api_token_id: issued.id,
    });

    return { ok: true };
  });
}

export const EXCHANGE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
});

export async function exchangePairing(pairingId) {
  return sequelize.transaction(async (t) => {
    const row = await PairingCode.findByPk(pairingId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!row) return { status: EXCHANGE_STATUS.EXPIRED };

    if (row.expires_at < new Date()) {
      await row.destroy({ transaction: t });
      return { status: EXCHANGE_STATUS.EXPIRED };
    }

    if (row.status === 'pending') {
      return { status: EXCHANGE_STATUS.PENDING };
    }

    if (row.status === 'approved') {
      const token = row.token_plaintext;
      row.status = 'consumed';
      row.token_plaintext = null;
      await row.save({ transaction: t });
      logger.info('pairing: consumed', { pairing_id: row.id, user_id: row.user_id });
      return { status: EXCHANGE_STATUS.APPROVED, token };
    }

    return { status: EXCHANGE_STATUS.CONSUMED };
  });
}

export async function cleanupExpired() {
  const cutoff = new Date(Date.now() - CLEANUP_GRACE_SECONDS * 1000);
  const deleted = await PairingCode.destroy({
    where: { expires_at: { [Op.lt]: cutoff } },
  });
  if (deleted > 0) {
    logger.info('pairing: cleanup', { deleted });
  }
  return deleted;
}
