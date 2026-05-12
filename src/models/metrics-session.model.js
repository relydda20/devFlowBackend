import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import User from './user.model.js';
import Session from './session.model.js';

const MetricsSession = sequelize.define('MetricsSession', {
  session_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: Session, key: 'id' },
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: User, key: 'id' },
  },
  lines_added: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  },
  lines_deleted: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  },
  editor_switch_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  rapid_switch_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  top_files: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'metrics_session',
  timestamps: false,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
  ],
});

User.hasMany(MetricsSession, { foreignKey: 'user_id' });
MetricsSession.belongsTo(User, { foreignKey: 'user_id' });
Session.hasOne(MetricsSession, { foreignKey: 'session_id' });
MetricsSession.belongsTo(Session, { foreignKey: 'session_id' });

export default MetricsSession;
