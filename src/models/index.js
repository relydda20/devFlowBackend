import User from './user.model.js';
import Session from './session.model.js';
import Activity from './activity.model.js';
import WorkflowState from './workflow-state.model.js';
import Recommendation from './recommendation.model.js';

// All associations are already defined in individual model files
// This file just exports them for easy importing

export {
  User,
  Session,
  Activity,
  WorkflowState,
  Recommendation
};
