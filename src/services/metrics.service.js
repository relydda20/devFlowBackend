import { Op } from 'sequelize';
import MetricsDaily from '../models/metrics-daily.model.js';
import MetricsSession from '../models/metrics-session.model.js';
import Session from '../models/session.model.js';

export const CHURN_DEFINITION = 'typing-heuristic';
export const SWITCH_DEFINITION = 'editor-switch-count';

function computeRatio(added, deleted) {
  if (added <= 0) return null;
  return Math.min(1, deleted / added);
}

function mergeTopFiles(rows, topN) {
  const merged = new Map();
  for (const row of rows) {
    const list = Array.isArray(row.top_files) ? row.top_files : [];
    for (const entry of list) {
      if (!entry || typeof entry.path !== 'string' || !Number.isFinite(entry.count)) continue;
      merged.set(entry.path, (merged.get(entry.path) ?? 0) + entry.count);
    }
  }
  return Array.from(merged, ([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

async function dailyRowsForRange(userId, from, to) {
  return MetricsDaily.findAll({
    where: {
      user_id: userId,
      date: { [Op.between]: [from, to] },
    },
    raw: true,
  });
}

async function sessionRowsForRange(userId, from, to) {
  // A session's metrics row is "in range" if the parent session's start_time is in range.
  // Join via the Session model.
  return MetricsSession.findAll({
    where: { user_id: userId },
    include: [{
      model: Session,
      required: true,
      attributes: ['id', 'start_time'],
      where: {
        start_time: {
          [Op.gte]: new Date(`${from}T00:00:00.000Z`),
          [Op.lte]: new Date(`${to}T23:59:59.999Z`),
        },
      },
    }],
  });
}

export async function getChurn({ userId, from, to, grain }) {
  if (grain === 'session') {
    const rows = await sessionRowsForRange(userId, from, to);
    const sessions = rows.map((row) => {
      const added = Number(row.lines_added) || 0;
      const deleted = Number(row.lines_deleted) || 0;
      return {
        session_id: row.session_id,
        ratio: computeRatio(added, deleted),
        total_lines_added: added,
        total_lines_deleted: deleted,
      };
    });
    return { sessions, definition: CHURN_DEFINITION, from, to, grain };
  }

  const rows = await dailyRowsForRange(userId, from, to);
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    added += Number(row.lines_added) || 0;
    deleted += Number(row.lines_deleted) || 0;
  }
  return {
    ratio: computeRatio(added, deleted),
    total_lines_added: added,
    total_lines_deleted: deleted,
    definition: CHURN_DEFINITION,
    from,
    to,
    grain: 'daily',
  };
}

export async function getContextSwitching({ userId, from, to, grain, topN }) {
  if (grain === 'session') {
    const rows = await sessionRowsForRange(userId, from, to);
    const sessions = rows.map((row) => ({
      session_id: row.session_id,
      switch_count: Number(row.editor_switch_count) || 0,
      rapid_switch_count: Number(row.rapid_switch_count) || 0,
      top_files: Array.isArray(row.top_files) ? row.top_files.slice(0, topN) : [],
    }));
    return { sessions, definition: SWITCH_DEFINITION, from, to, grain };
  }

  const rows = await dailyRowsForRange(userId, from, to);
  let switchCount = 0;
  let rapidCount = 0;
  for (const row of rows) {
    switchCount += Number(row.editor_switch_count) || 0;
    rapidCount += Number(row.rapid_switch_count) || 0;
  }
  return {
    switch_count: switchCount,
    rapid_switch_count: rapidCount,
    top_files: mergeTopFiles(rows, topN),
    definition: SWITCH_DEFINITION,
    from,
    to,
    grain: 'daily',
  };
}
