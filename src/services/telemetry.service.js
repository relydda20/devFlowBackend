import { sequelize } from '../config/database.js';
import { User, Session, Activity } from '../models/index.js';
import { mapEventToActivity } from './telemetry-mapper.js';

export class UserNotFoundError extends Error {
  constructor(userId) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
    this.userId = userId;
  }
}

export class SessionOwnershipConflictError extends Error {
  constructor(sessionId) {
    super(`Session ${sessionId} is owned by a different user`);
    this.name = 'SessionOwnershipConflictError';
    this.sessionId = sessionId;
  }
}

export async function ingestBatch({ user_id, payload }) {
  const events = Array.isArray(payload?.events) ? payload.events : [];

  return sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(user_id, { transaction });
    if (!user) throw new UserNotFoundError(user_id);

    const earliestBySession = new Map();
    for (const ev of events) {
      const ts = new Date(ev.timestamp);
      const current = earliestBySession.get(ev.session_id);
      if (!current || ts < current) earliestBySession.set(ev.session_id, ts);
    }

    for (const [session_id, start_time] of earliestBySession) {
      const [session] = await Session.findOrCreate({
        where: { id: session_id },
        defaults: { id: session_id, user_id, start_time, is_active: true },
        transaction,
      });
      if (session.user_id !== user_id) {
        throw new SessionOwnershipConflictError(session_id);
      }
    }

    const rows = events.map(mapEventToActivity);
    await Activity.bulkCreate(rows, { transaction });

    return { accepted_count: events.length };
  });
}
