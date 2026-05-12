import { sequelize } from '../config/database.js';
import { User, Session, Activity } from '../models/index.js';

export class UserNotFoundError extends Error {
  constructor(userId) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
    this.userId = userId;
  }
}

export async function ingestBatch({ user_id, events }) {
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
      await Session.findOrCreate({
        where: { id: session_id },
        defaults: { id: session_id, user_id, start_time, is_active: true },
        transaction,
      });
    }

    const rows = events.map((ev) => ({
      session_id: ev.session_id,
      event_type: ev.event_type,
      file_path: ev.file_path ?? null,
      metadata: ev.metadata ?? {},
      timestamp: ev.timestamp,
    }));
    await Activity.bulkCreate(rows, { transaction });

    return { accepted_count: events.length };
  });
}
