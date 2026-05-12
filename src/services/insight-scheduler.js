import logger from '../utils/logger.js';
import { evaluateUser, listCandidateUsers } from './insight-trigger.service.js';
import { isConfigured as isGeminiConfigured } from './llm/gemini.service.js';
import { cleanupExpired as cleanupExpiredPairings } from './pairing.service.js';

const PAIRING_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function readIntervalSeconds() {
  const raw = Number(process.env.INSIGHT_CHECK_INTERVAL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
}

function isEnabled() {
  const raw = process.env.INSIGHTS_ENABLED;
  if (raw === undefined || raw === null || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

let timer = null;
let pairingTimer = null;
const inFlight = new Set();

async function processOneUser(userId) {
  if (inFlight.has(userId)) return;
  inFlight.add(userId);
  try {
    await evaluateUser(userId);
  } catch (err) {
    logger.error('insight-scheduler: user evaluation crashed', {
      user_id: userId,
      error: err.message,
      stack: err.stack,
    });
  } finally {
    inFlight.delete(userId);
  }
}

async function tick() {
  try {
    const users = await listCandidateUsers();
    if (users.length === 0) {
      logger.debug('insight-scheduler: no active users this tick');
      return;
    }
    await Promise.all(users.map((userId) => processOneUser(userId)));
  } catch (err) {
    logger.error('insight-scheduler: tick failed', { error: err.message, stack: err.stack });
  }
}

function startPairingCleanup() {
  if (pairingTimer) return;
  pairingTimer = setInterval(() => {
    cleanupExpiredPairings().catch((err) => {
      logger.error('pairing-cleanup: tick failed', { error: err.message });
    });
  }, PAIRING_CLEANUP_INTERVAL_MS);
}

export function start() {
  startPairingCleanup();

  if (!isEnabled()) {
    logger.info('insight-scheduler: disabled via INSIGHTS_ENABLED');
    return;
  }
  if (!isGeminiConfigured()) {
    logger.warn('insight-scheduler: GOOGLE_API_KEY not set — insights disabled for this process');
    return;
  }
  if (timer) return;
  const intervalMs = readIntervalSeconds() * 1000;
  timer = setInterval(() => { void tick(); }, intervalMs);
  logger.info(`insight-scheduler: started, interval=${readIntervalSeconds()}s`);
}

export function stop() {
  if (pairingTimer) {
    clearInterval(pairingTimer);
    pairingTimer = null;
  }
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('insight-scheduler: stopped');
}
