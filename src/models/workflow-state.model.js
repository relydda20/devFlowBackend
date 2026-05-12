import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import Session from './session.model.js';

const WorkflowState = sequelize.define('WorkflowState', {
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
  state_type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  confidence_score: {
    type: DataTypes.DECIMAL(3, 2),
    allowNull: false,
    validate: {
      min: 0,
      max: 1
    }
  },
  duration_minutes: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  triggered_intervention: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'workflow_states',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      fields: ['session_id', 'created_at']
    }
  ]
});

// Define associations
Session.hasMany(WorkflowState, { foreignKey: 'session_id' });
WorkflowState.belongsTo(Session, { foreignKey: 'session_id' });

export default WorkflowState;
