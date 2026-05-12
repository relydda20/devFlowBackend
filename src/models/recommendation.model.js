import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import WorkflowState from './workflow-state.model.js';

const Recommendation = sequelize.define('Recommendation', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true
  },
  workflow_state_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    references: {
      model: WorkflowState,
      key: 'id'
    }
  },
  recommendation_type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  recommendation_text: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  code_context: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  user_action: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  outcome_improved: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'recommendations',
  timestamps: false,
  underscored: true
});

// Define associations
WorkflowState.hasOne(Recommendation, { foreignKey: 'workflow_state_id' });
Recommendation.belongsTo(WorkflowState, { foreignKey: 'workflow_state_id' });

export default Recommendation;
