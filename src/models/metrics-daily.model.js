import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import User from './user.model.js';

const MetricsDaily = sequelize.define('MetricsDaily', {
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    primaryKey: true,
    references: { model: User, key: 'id' },
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    primaryKey: true,
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
  tableName: 'metrics_daily',
  timestamps: false,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
  ],
});

User.hasMany(MetricsDaily, { foreignKey: 'user_id' });
MetricsDaily.belongsTo(User, { foreignKey: 'user_id' });

export default MetricsDaily;
