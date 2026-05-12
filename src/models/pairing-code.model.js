import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import User from './user.model.js';
import ApiToken from './api-token.model.js';

const PairingCode = sequelize.define('PairingCode', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_code: {
    type: DataTypes.STRING(9),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'consumed'),
    allowNull: false,
    defaultValue: 'pending',
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: User, key: 'id' },
  },
  api_token_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: ApiToken, key: 'id' },
  },
  token_plaintext: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  tableName: 'pairing_codes',
  timestamps: true,
  updatedAt: false,
  underscored: true,
});

User.hasMany(PairingCode, { foreignKey: 'user_id' });
PairingCode.belongsTo(User, { foreignKey: 'user_id' });
ApiToken.hasOne(PairingCode, { foreignKey: 'api_token_id' });
PairingCode.belongsTo(ApiToken, { foreignKey: 'api_token_id' });

export default PairingCode;
