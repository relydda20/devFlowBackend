import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

const VALID_ACTIONS = ['accepted', 'dismissed', 'snoozed'];

function shapeRecommendation(row) {
  return {
    id: row.id,
    state_type: row.state_type,
    confidence_score: Number(row.confidence_score),
    recommendation_type: row.recommendation_type,
    recommendation_text: row.recommendation_text,
    reasoning: row.code_context?.reasoning ?? null,
    user_action: row.user_action,
    created_at: row.created_at,
  };
}

export async function getPending(req, res, next) {
  try {
    const rows = await sequelize.query(
      `SELECT r.id, ws.state_type, ws.confidence_score, r.recommendation_type, r.recommendation_text,
              r.code_context, r.user_action, r.created_at
         FROM recommendations r
         JOIN workflow_states ws ON ws.id = r.workflow_state_id
         JOIN sessions s ON s.id = ws.session_id
        WHERE s.user_id = :user_id AND r.user_action IS NULL
        ORDER BY r.created_at DESC
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { user_id: req.user.id } },
    );
    if (rows.length === 0) {
      return res.json({ recommendation: null });
    }
    return res.json({ recommendation: shapeRecommendation(rows[0]) });
  } catch (err) {
    next(err);
  }
}

export async function getRecent(req, res, next) {
  try {
    let limit = 20;
    if (req.query.limit !== undefined) {
      const raw = Number(req.query.limit);
      if (!Number.isInteger(raw) || raw < 1) {
        return res.status(400).json({ error: 'Validation failed', message: 'limit must be a positive integer' });
      }
      limit = Math.min(raw, 100);
    }

    const rows = await sequelize.query(
      `SELECT r.id, ws.state_type, ws.confidence_score, r.recommendation_type, r.recommendation_text,
              r.code_context, r.user_action, r.created_at
         FROM recommendations r
         JOIN workflow_states ws ON ws.id = r.workflow_state_id
         JOIN sessions s ON s.id = ws.session_id
        WHERE s.user_id = :user_id
        ORDER BY r.created_at DESC
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { user_id: req.user.id, limit } },
    );

    return res.json({ recommendations: rows.map(shapeRecommendation) });
  } catch (err) {
    next(err);
  }
}

export async function postAction(req, res, next) {
  try {
    const action = req.body?.action;
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({
        error: 'Validation failed',
        message: `action must be one of ${VALID_ACTIONS.join(', ')}`,
      });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Validation failed', message: 'id must be a positive integer' });
    }

    const [row] = await sequelize.query(
      `SELECT r.id, r.user_action, s.user_id
         FROM recommendations r
         JOIN workflow_states ws ON ws.id = r.workflow_state_id
         JOIN sessions s ON s.id = ws.session_id
        WHERE r.id = :id`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );

    if (!row) return res.status(404).json({ error: 'Recommendation not found' });
    if (row.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (row.user_action !== null) {
      return res.status(409).json({ error: 'Recommendation already acted on' });
    }

    await sequelize.query(
      `UPDATE recommendations SET user_action = :action WHERE id = :id`,
      { replacements: { action, id } },
    );

    return res.json({ id, user_action: action });
  } catch (err) {
    next(err);
  }
}
