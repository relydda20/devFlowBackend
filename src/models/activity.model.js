import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import Session from './session.model.js';

const Activity = sequelize.define('Activity', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: Session,
      key: 'id'
    }
  },
  event_type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  file_path: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: {}
  },
  timestamp: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'activities',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      fields: ['session_id', 'timestamp']
    },
    {
      fields: ['event_type']
    }
  ]
});

// Define associations
Session.hasMany(Activity, { foreignKey: 'session_id' });
Activity.belongsTo(Session, { foreignKey: 'session_id' });

export default Activity;
