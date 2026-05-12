import logger from '../utils/logger.js';
import { runOnce } from './metrics-etl.service.js';

function readIntervalSeconds() {
  const raw = Number(process.env.METRICS_ETL_INTERVAL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

function readBatchSize() {
  const raw = Number(process.env.METRICS_ETL_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

function isEnabled() {
  const raw = process.env.METRICS_ETL_ENABLED;
  if (raw === undefined || raw === null || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

let timer = null;
let isRunning = false;

async function tick() {
  if (isRunning) {
    logger.debug('metrics-etl: previous pass still running, skipping tick');
    return;
  }
  isRunning = true;
  try {
    const result = await runOnce({ batchSize: readBatchSize() });
    if (result.processed_count > 0) {
      logger.info('metrics-etl: pass complete', result);
    }
  } catch (err) {
    logger.error('metrics-etl: pass failed', { error: err.message, stack: err.stack });
  } finally {
    isRunning = false;
  }
}

export function start() {
  if (!isEnabled()) {
    logger.info('metrics-etl: disabled via METRICS_ETL_ENABLED');
    return;
  }
  if (timer) return;
  const intervalMs = readIntervalSeconds() * 1000;
  timer = setInterval(() => { void tick(); }, intervalMs);
  logger.info(`metrics-etl: scheduler started, interval=${readIntervalSeconds()}s`);
}

export function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('metrics-etl: scheduler stopped');
}

export async function triggerNow() {
  if (isRunning) {
    return { status: 'in_flight' };
  }
  isRunning = true;
  try {
    const result = await runOnce({ batchSize: readBatchSize() });
    return { status: 'ok', result };
  } finally {
    isRunning = false;
  }
}
