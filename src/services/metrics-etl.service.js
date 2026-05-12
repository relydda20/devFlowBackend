import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import logger from '../utils/logger.js';

const JOB_KEY = 'metrics';
const TOP_FILES_CAP = 20;

function toDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function sumLineRangeWidth(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return 0;
  let total = 0;
  for (const r of ranges) {
    if (!r) continue;
    const start = Number(r.start);
    const end = Number(r.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      total += end - start + 1;
    }
  }
  return total;
}

function bumpTopFiles(map, path) {
  if (typeof path !== 'string' || path.length === 0) return;
  map.set(path, (map.get(path) ?? 0) + 1);
}

function mergeTopFilesIntoExisting(existing, incomingMap) {
  const merged = new Map();
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (entry && typeof entry.path === 'string' && Number.isFinite(entry.count)) {
        merged.set(entry.path, entry.count);
      }
    }
  }
  for (const [path, count] of incomingMap) {
    merged.set(path, (merged.get(path) ?? 0) + count);
  }
  return Array.from(merged, ([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_FILES_CAP);
}

function aggregateTextChanges(rows) {
  const daily = new Map();
  const session = new Map();

  for (const row of rows) {
    const meta = row.metadata ?? {};
    const metrics = meta.metrics ?? {};
    const ranges = metrics.affected_line_ranges;

    if (!Array.isArray(ranges) || ranges.length === 0) {
      logger.warn('metrics-etl: text_change missing affected_line_ranges', { activity_id: row.id });
    }

    const width = sumLineRangeWidth(ranges);
    const linesAdded = metrics.characters_added > 0 ? width : 0;
    const linesDeleted = metrics.characters_deleted > 0 ? width : 0;

    if (linesAdded === 0 && linesDeleted === 0) continue;

    const date = toDate(row.timestamp);
    const userKey = `${row.user_id}|${date}`;
    const userBucket = daily.get(userKey) ?? { user_id: row.user_id, date, lines_added: 0, lines_deleted: 0 };
    userBucket.lines_added += linesAdded;
    userBucket.lines_deleted += linesDeleted;
    daily.set(userKey, userBucket);

    const sessionBucket = session.get(row.session_id) ?? {
      session_id: row.session_id,
      user_id: row.user_id,
      lines_added: 0,
      lines_deleted: 0,
    };
    sessionBucket.lines_added += linesAdded;
    sessionBucket.lines_deleted += linesDeleted;
    session.set(row.session_id, sessionBucket);
  }

  return { daily, session };
}

function aggregateEditorSwitches(rows) {
  const daily = new Map();
  const session = new Map();

  for (const row of rows) {
    const meta = row.metadata ?? {};
    const metrics = meta.metrics ?? {};
    const toFile = meta.to?.file;
    const isRapid = metrics.is_rapid_context_switching === true;

    const date = toDate(row.timestamp);
    const userKey = `${row.user_id}|${date}`;
    const userBucket = daily.get(userKey) ?? {
      user_id: row.user_id,
      date,
      editor_switch_count: 0,
      rapid_switch_count: 0,
      top_files: new Map(),
    };
    userBucket.editor_switch_count += 1;
    if (isRapid) userBucket.rapid_switch_count += 1;
    bumpTopFiles(userBucket.top_files, toFile);
    daily.set(userKey, userBucket);

    const sessionBucket = session.get(row.session_id) ?? {
      session_id: row.session_id,
      user_id: row.user_id,
      editor_switch_count: 0,
      rapid_switch_count: 0,
      top_files: new Map(),
    };
    sessionBucket.editor_switch_count += 1;
    if (isRapid) sessionBucket.rapid_switch_count += 1;
    bumpTopFiles(sessionBucket.top_files, toFile);
    session.set(row.session_id, sessionBucket);
  }

  return { daily, session };
}

async function upsertMetricsDaily(t, textDaily, switchDaily) {
  const keys = new Set([...textDaily.keys(), ...switchDaily.keys()]);
  if (keys.size === 0) return;

  for (const key of keys) {
    const text = textDaily.get(key);
    const sw = switchDaily.get(key);
    const userId = text?.user_id ?? sw?.user_id;
    const date = text?.date ?? sw?.date;

    const linesAddedDelta = text?.lines_added ?? 0;
    const linesDeletedDelta = text?.lines_deleted ?? 0;
    const switchDelta = sw?.editor_switch_count ?? 0;
    const rapidDelta = sw?.rapid_switch_count ?? 0;
    const incomingTopFiles = sw?.top_files ?? new Map();

    const [existing] = await sequelize.query(
      `SELECT top_files FROM metrics_daily WHERE user_id = :user_id AND date = :date FOR UPDATE`,
      { type: QueryTypes.SELECT, replacements: { user_id: userId, date }, transaction: t }
    );
    const mergedTopFiles = mergeTopFilesIntoExisting(existing?.top_files ?? [], incomingTopFiles);

    await sequelize.query(
      `INSERT INTO metrics_daily
         (user_id, date, lines_added, lines_deleted, editor_switch_count, rapid_switch_count, top_files, updated_at)
       VALUES
         (:user_id, :date, :lines_added, :lines_deleted, :switch_count, :rapid_count, :top_files::jsonb, NOW())
       ON CONFLICT (user_id, date) DO UPDATE SET
         lines_added = metrics_daily.lines_added + EXCLUDED.lines_added,
         lines_deleted = metrics_daily.lines_deleted + EXCLUDED.lines_deleted,
         editor_switch_count = metrics_daily.editor_switch_count + EXCLUDED.editor_switch_count,
         rapid_switch_count = metrics_daily.rapid_switch_count + EXCLUDED.rapid_switch_count,
         top_files = EXCLUDED.top_files,
         updated_at = NOW()`,
      {
        replacements: {
          user_id: userId,
          date,
          lines_added: linesAddedDelta,
          lines_deleted: linesDeletedDelta,
          switch_count: switchDelta,
          rapid_count: rapidDelta,
          top_files: JSON.stringify(mergedTopFiles),
        },
        transaction: t,
      }
    );
  }
}

async function upsertMetricsSession(t, textSession, switchSession) {
  const ids = new Set([...textSession.keys(), ...switchSession.keys()]);
  if (ids.size === 0) return;

  for (const sessionId of ids) {
    const text = textSession.get(sessionId);
    const sw = switchSession.get(sessionId);
    const userId = text?.user_id ?? sw?.user_id;

    const linesAddedDelta = text?.lines_added ?? 0;
    const linesDeletedDelta = text?.lines_deleted ?? 0;
    const switchDelta = sw?.editor_switch_count ?? 0;
    const rapidDelta = sw?.rapid_switch_count ?? 0;
    const incomingTopFiles = sw?.top_files ?? new Map();

    const [existing] = await sequelize.query(
      `SELECT top_files FROM metrics_session WHERE session_id = :session_id FOR UPDATE`,
      { type: QueryTypes.SELECT, replacements: { session_id: sessionId }, transaction: t }
    );
    const mergedTopFiles = mergeTopFilesIntoExisting(existing?.top_files ?? [], incomingTopFiles);

    await sequelize.query(
      `INSERT INTO metrics_session
         (session_id, user_id, lines_added, lines_deleted, editor_switch_count, rapid_switch_count, top_files, updated_at)
       VALUES
         (:session_id, :user_id, :lines_added, :lines_deleted, :switch_count, :rapid_count, :top_files::jsonb, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         lines_added = metrics_session.lines_added + EXCLUDED.lines_added,
         lines_deleted = metrics_session.lines_deleted + EXCLUDED.lines_deleted,
         editor_switch_count = metrics_session.editor_switch_count + EXCLUDED.editor_switch_count,
         rapid_switch_count = metrics_session.rapid_switch_count + EXCLUDED.rapid_switch_count,
         top_files = EXCLUDED.top_files,
         updated_at = NOW()`,
      {
        replacements: {
          session_id: sessionId,
          user_id: userId,
          lines_added: linesAddedDelta,
          lines_deleted: linesDeletedDelta,
          switch_count: switchDelta,
          rapid_count: rapidDelta,
          top_files: JSON.stringify(mergedTopFiles),
        },
        transaction: t,
      }
    );
  }
}

export async function runOnce({ batchSize = 5000 } = {}) {
  const startedAt = Date.now();

  return sequelize.transaction(async (t) => {
    const [job] = await sequelize.query(
      `SELECT last_processed_activity_id
         FROM etl_jobs
        WHERE job_key = :job_key
        FOR UPDATE`,
      { type: QueryTypes.SELECT, replacements: { job_key: JOB_KEY }, transaction: t }
    );

    const watermarkBefore = job ? Number(job.last_processed_activity_id) : 0;

    const rows = await sequelize.query(
      `SELECT a.id, a.session_id, a.event_type, a.file_path, a.metadata, a.timestamp,
              s.user_id
         FROM activities a
         JOIN sessions s ON s.id = a.session_id
        WHERE a.id > :watermark
        ORDER BY a.id ASC
        LIMIT :batch_size`,
      {
        type: QueryTypes.SELECT,
        replacements: { watermark: watermarkBefore, batch_size: batchSize },
        transaction: t,
      }
    );

    if (rows.length === 0) {
      return {
        processed_count: 0,
        watermark_before: watermarkBefore,
        watermark_after: watermarkBefore,
        duration_ms: Date.now() - startedAt,
      };
    }

    const textRows = rows.filter((r) => r.event_type === 'text_change');
    const switchRows = rows.filter((r) => r.event_type === 'editor_switch');
    const text = aggregateTextChanges(textRows);
    const switches = aggregateEditorSwitches(switchRows);

    await upsertMetricsDaily(t, text.daily, switches.daily);
    await upsertMetricsSession(t, text.session, switches.session);

    const watermarkAfter = Number(rows[rows.length - 1].id);

    await sequelize.query(
      `INSERT INTO etl_jobs (job_key, last_processed_activity_id, last_run_at, last_duration_ms)
       VALUES (:job_key, :wm, NOW(), :dur)
       ON CONFLICT (job_key) DO UPDATE SET
         last_processed_activity_id = EXCLUDED.last_processed_activity_id,
         last_run_at = EXCLUDED.last_run_at,
         last_duration_ms = EXCLUDED.last_duration_ms`,
      {
        replacements: {
          job_key: JOB_KEY,
          wm: watermarkAfter,
          dur: Date.now() - startedAt,
        },
        transaction: t,
      }
    );

    return {
      processed_count: rows.length,
      watermark_before: watermarkBefore,
      watermark_after: watermarkAfter,
      duration_ms: Date.now() - startedAt,
    };
  });
}
