import 'dotenv/config';
import logger from './utils/logger.js';
import { testConnection } from './config/database.js';

async function runTests() {
  logger.info('=== Testing Ticket #2 Components ===');
  
  // Test 1: Logger
  logger.info('✅ Logger is working!');
  logger.debug('Debug message (only shows in development)');
  logger.warn('Warning message');
  logger.error('Error message', { example: 'error metadata' });
  
  // Test 2: Database Connection
  try {
    await testConnection();
    logger.info('✅ Database connection is working!');
  } catch (error) {
    logger.error('❌ Database connection failed');
    process.exit(1);
  }
  
  logger.info('=== All Ticket #2 Tests Passed! ===');
  process.exit(0);
}

runTests();
