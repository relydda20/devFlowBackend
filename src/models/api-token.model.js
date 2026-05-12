import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import User from './user.model.js';

const ApiToken = sequelize.define('ApiToken', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: User, key: 'id' },
  },
  name: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  token_hash: {
    type: DataTypes.CHAR(64),
    allowNull: false,
    unique: true,
  },
  token_prefix: {
    type: DataTypes.STRING(8),
    allowNull: false,
  },
  last_used_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  revoked_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'api_tokens',
  timestamps: true,
  updatedAt: false,
  underscored: true,
});

User.hasMany(ApiToken, { foreignKey: 'user_id' });
ApiToken.belongsTo(User, { foreignKey: 'user_id' });

export default ApiToken;
