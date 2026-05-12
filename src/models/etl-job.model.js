import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

const EtlJob = sequelize.define('EtlJob', {
  job_key: {
    type: DataTypes.STRING(64),
    primaryKey: true,
  },
  last_processed_activity_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  },
  last_run_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  last_duration_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'etl_jobs',
  timestamps: false,
  underscored: true,
});

export default EtlJob;
