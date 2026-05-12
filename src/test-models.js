import 'dotenv/config';
import logger from './utils/logger.js';
import { sequelize } from './config/database.js';
import { User, Session, Activity, WorkflowState, Recommendation } from './models/index.js';

async function testModels() {
  try {
    logger.info('=== Testing Ticket #3: Database Models ===');
    
    // Test 1: Connect to database
    await sequelize.authenticate();
    logger.info('✅ Database connected');
    
    // Test 2: Sync models (create tables)
    logger.info('Creating tables...');
    await sequelize.sync({ force: true }); // force: true drops existing tables
    logger.info('✅ All tables created successfully');
    
    // Test 3: Create a test user
    const user = await User.create({
      username: 'test_user',
      email: 'test@devflow.ai',
      provider: 'password',
      provider_user_id: 'test@devflow.ai'
    });
    logger.info('✅ Created test user', { id: user.id, username: user.username });
    
    // Test 4: Create a session for the user
    const session = await Session.create({
      user_id: user.id,
      start_time: new Date(),
      is_active: true
    });
    logger.info('✅ Created test session', { id: session.id });
    
    // Test 5: Create an activity
    const activity = await Activity.create({
      session_id: session.id,
      event_type: 'file_save',
      file_path: 'src/test.js',
      metadata: { lines_added: 10, lines_deleted: 5 },
      timestamp: new Date()
    });
    logger.info('✅ Created test activity', { id: activity.id, event_type: activity.event_type });
    
    // Test 6: Create a workflow state
    const workflowState = await WorkflowState.create({
      session_id: session.id,
      state_type: 'normal',
      confidence_score: 0.95,
      duration_minutes: 10
    });
    logger.info('✅ Created workflow state', { id: workflowState.id, state_type: workflowState.state_type });
    
    // Test 7: Create a recommendation
    const recommendation = await Recommendation.create({
      workflow_state_id: workflowState.id,
      recommendation_type: 'change_approach',
      recommendation_text: 'Consider a different strategy',
      code_context: { files: ['src/test.js'] }
    });
    logger.info('✅ Created recommendation', { id: recommendation.id });
    
    // Test 8: Test associations (relationships)
    const userWithSessions = await User.findByPk(user.id, {
      include: [Session]
    });
    logger.info('✅ Association test passed', { 
      user: userWithSessions.username, 
      sessions: userWithSessions.Sessions.length 
    });
    
    logger.info('=== All Ticket #3 Tests Passed! ===');
    logger.info('Database schema is ready for use.');
    
    process.exit(0);
  } catch (error) {
    logger.error('Test failed', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

testModels();
