import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  username: {
    type: DataTypes.STRING(50),
    unique: true,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  provider: {
    type: DataTypes.ENUM('google', 'github'),
    allowNull: false
  },
  provider_user_id: {
    type: DataTypes.TEXT,
    allowNull: false
  }
}, {
  tableName: 'users',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['provider', 'provider_user_id'] }
  ]
});

export default User;
