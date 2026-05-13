import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  Session,
  WorkflowState,
  Recommendation,
} from '../models/index.js';
import { generateInsight, isConfigured as isGeminiConfigured } from './llm/gemini.service.js';

const DEMO_RECOMMENDATION_TEXT =
  "You've been heads-down for a while. Consider stepping away for 5 minutes — your next bug is probably hiding behind a clear head.";
const DEMO_REASONING = 'Manually triggered demo recommendation; no Gemini call was made.';

const ACTIVITY_WINDOW_MINUTES = () =>
  positiveInt(process.env.INSIGHT_ACTIVITY_WINDOW_MINUTES, 30);
const COOLDOWN_MINUTES = () =>
  positiveInt(process.env.INSIGHT_COOLDOWN_MINUTES, 45);
const SNOOZE_MINUTES = () =>
  positiveInt(process.env.SNOOZE_DURATION_MINUTES, 30);

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function minutesAgo(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / 60000;
}

async function listActiveUsers() {
  const windowMin = ACTIVITY_WINDOW_MINUTES();
  const rows = await sequelize.query(
    `SELECT DISTINCT s.user_id
       FROM sessions s
       JOIN activities a ON a.session_id = s.id
      WHERE a.timestamp > NOW() - (INTERVAL '1 minute' * :window_min)`,
    { type: QueryTypes.SELECT, replacements: { window_min: windowMin } },
  );
  return rows.map((r) => r.user_id);
}

async function getCurrentSessionForUser(userId) {
  // Treat the most-recent session as "current"; the extension rotates sessions
  // by activity, so this captures the live one.
  const rows = await sequelize.query(
    `SELECT id, start_time
       FROM sessions
      WHERE user_id = :user_id
      ORDER BY start_time DESC
      LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { user_id: userId } },
  );
  if (rows.length === 0) return null;
  const session = rows[0];
  const startedAt = new Date(session.start_time);
  return {
    id: session.id,
    started_at: startedAt.toISOString(),
    duration_minutes: Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 60000)),
  };
}

async function getTodayMetrics(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const [row] = await sequelize.query(
    `SELECT lines_added, lines_deleted, editor_switch_count, rapid_switch_count, top_files
       FROM metrics_daily
      WHERE user_id = :user_id AND date = :date`,
    { type: QueryTypes.SELECT, replacements: { user_id: userId, date: today } },
  );
  if (!row) {
    return {
      lines_added: 0,
      lines_deleted: 0,
      churn_ratio: null,
      switch_count: 0,
      rapid_switch_count: 0,
      top_files: [],
    };
  }
  const added = Number(row.lines_added) || 0;
  const deleted = Number(row.lines_deleted) || 0;
  const churn = added > 0 ? Math.min(1, deleted / added) : null;
  return {
    lines_added: added,
    lines_deleted: deleted,
    churn_ratio: churn,
    switch_count: Number(row.editor_switch_count) || 0,
    rapid_switch_count: Number(row.rapid_switch_count) || 0,
    top_files: Array.isArray(row.top_files) ? row.top_files : [],
  };
}

async function getLatestRecommendationForUser(userId) {
  // Latest recommendation regardless of action — used for both cooldown and snooze checks.
  const [row] = await sequelize.query(
    `SELECT r.id, r.user_action, r.created_at, ws.session_id
       FROM recommendations r
       JOIN workflow_states ws ON ws.id = r.workflow_state_id
       JOIN sessions s ON s.id = ws.session_id
      WHERE s.user_id = :user_id
      ORDER BY r.created_at DESC
      LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { user_id: userId } },
  );
  return row || null;
}

function evaluateRules({ metrics, session }) {
  const longSession = (session?.duration_minutes ?? 0) > 120;
  const highChurn = (metrics.churn_ratio ?? 0) > 0.4;
  const veryLongSession = (session?.duration_minutes ?? 0) > 240;
  const rapidSwitching = metrics.rapid_switch_count > 30;
  const deleteHeavy = metrics.lines_deleted > metrics.lines_added && (metrics.lines_added + metrics.lines_deleted) > 50;

  if (veryLongSession) {
    return { triggered: true, rule: 'very_long_session' };
  }
  if (longSession && highChurn) {
    return { triggered: true, rule: 'long_session_high_churn' };
  }
  if (rapidSwitching) {
    return { triggered: true, rule: 'rapid_context_switching' };
  }
  if (deleteHeavy) {
    return { triggered: true, rule: 'delete_heavy_rewriting' };
  }
  return { triggered: false, rule: null };
}

function isInCooldown(latest) {
  if (!latest) return false;
  if (latest.user_action === 'snoozed') {
    return minutesAgo(latest.created_at) < SNOOZE_MINUTES();
  }
  return minutesAgo(latest.created_at) < COOLDOWN_MINUTES();
}

async function persistInsight({ userId, sessionId, triggeredRule, llmOutput }) {
  return sequelize.transaction(async (t) => {
    // Expire any prior pending recommendation for this user.
    await sequelize.query(
      `UPDATE recommendations
          SET user_action = 'expired'
        WHERE user_action IS NULL
          AND workflow_state_id IN (
            SELECT ws.id FROM workflow_states ws
              JOIN sessions s ON s.id = ws.session_id
             WHERE s.user_id = :user_id
          )`,
      { replacements: { user_id: userId }, transaction: t },
    );

    const workflowState = await WorkflowState.create(
      {
        session_id: sessionId,
        state_type: llmOutput.state_type,
        confidence_score: llmOutput.confidence_score,
      },
      { transaction: t },
    );

    // If the LLM determined nothing is wrong, log the state but skip the recommendation row.
    if (llmOutput.state_type === 'normal') {
      return { workflowState, recommendation: null };
    }

    const recommendation = await Recommendation.create(
      {
        workflow_state_id: workflowState.id,
        recommendation_type: llmOutput.recommendation_type,
        recommendation_text: llmOutput.recommendation_text,
        code_context: {
          reasoning: llmOutput.reasoning,
          triggered_rule: triggeredRule,
          evidence: llmOutput.evidence ?? [],
        },
        user_action: null,
      },
      { transaction: t },
    );

    return { workflowState, recommendation };
  });
}

export async function evaluateUser(userId) {
  if (!isGeminiConfigured()) {
    return { skipped: true, reason: 'gemini_not_configured' };
  }

  const latest = await getLatestRecommendationForUser(userId);
  if (isInCooldown(latest)) {
    return { skipped: true, reason: 'cooldown' };
  }

  const session = await getCurrentSessionForUser(userId);
  if (!session) {
    return { skipped: true, reason: 'no_session' };
  }

  const metrics = await getTodayMetrics(userId);
  const rule = evaluateRules({ metrics, session });
  if (!rule.triggered) {
    return { skipped: true, reason: 'no_rule_fired' };
  }

  let llmOutput;
  try {
    llmOutput = await generateInsight({
      metrics,
      session,
      topFiles: metrics.top_files,
      triggeredRule: rule.rule,
    });
  } catch (err) {
    logger.warn('insight-trigger: llm failed', {
      user_id: userId,
      rule: rule.rule,
      error: err.message,
      name: err.name,
    });
    return { skipped: true, reason: 'llm_failed' };
  }

  const persisted = await persistInsight({
    userId,
    sessionId: session.id,
    triggeredRule: rule.rule,
    llmOutput,
  });

  logger.info('insight-trigger: insight recorded', {
    user_id: userId,
    rule: rule.rule,
    state_type: llmOutput.state_type,
    confidence: llmOutput.confidence_score,
    recommendation_created: persisted.recommendation !== null,
  });

  return {
    skipped: false,
    rule: rule.rule,
    state_type: llmOutput.state_type,
    recommendation_id: persisted.recommendation?.id ?? null,
  };
}

export async function listCandidateUsers() {
  return listActiveUsers();
}

export async function expireLatestRecommendation(userId) {
  const [, affected] = await sequelize.query(
    `UPDATE recommendations
        SET user_action = 'expired'
      WHERE id = (
        SELECT r.id
          FROM recommendations r
          JOIN workflow_states ws ON ws.id = r.workflow_state_id
          JOIN sessions s ON s.id = ws.session_id
         WHERE s.user_id = :user_id
         ORDER BY r.created_at DESC
         LIMIT 1
      )
        AND user_action IS NULL`,
    { replacements: { user_id: userId } },
  );
  return typeof affected === 'number' ? affected : (affected?.rowCount ?? 0);
}

export async function createDemoRecommendation(userId) {
  const session = await getCurrentSessionForUser(userId);
  if (!session) {
    return { skipped: true, reason: 'no_session' };
  }

  const recommendationId = await sequelize.transaction(async (t) => {
    const workflowState = await WorkflowState.create(
      {
        session_id: session.id,
        state_type: 'demo',
        confidence_score: 1.0,
      },
      { transaction: t },
    );

    const recommendation = await Recommendation.create(
      {
        workflow_state_id: workflowState.id,
        recommendation_type: 'execute',
        recommendation_text: DEMO_RECOMMENDATION_TEXT,
        code_context: {
          reasoning: DEMO_REASONING,
          triggered_rule: 'demo_trigger',
          evidence: [
            { metric: 'duration_minutes', value: 145 },
            { metric: 'lines_added', value: 220 },
            { metric: 'lines_deleted', value: 180 },
            { metric: 'churn_ratio', value: 0.82 },
          ],
        },
        user_action: null,
      },
      { transaction: t },
    );

    return recommendation.id;
  });

  logger.info('recommendation-trigger: demo recommendation created', {
    user_id: userId,
    recommendation_id: recommendationId,
  });

  return { skipped: false, mode: 'demo', recommendation_id: recommendationId };
}
