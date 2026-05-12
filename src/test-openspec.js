import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { openspec, resolveRefs, getSchemaForEndpoint } from './config/openspec.js';

dotenv.config();

function testOpenSpecConfiguration() {
  logger.info('=== Testing Ticket #3.5: OpenSpec Configuration ===');
  
  // Test 1: OpenSpec loaded
  if (openspec) {
    logger.info('✅ OpenSpec object loaded');
  } else {
    logger.error('❌ OpenSpec not loaded');
    process.exit(1);
  }
  
  // Test 2: Check paths exist
  const paths = Object.keys(openspec.paths);
  logger.info(`✅ Found ${paths.length} endpoints:`, { paths });
  
  // Test 3: Check schemas exist
  const schemas = Object.keys(openspec.components?.schemas || {});
  logger.info(`✅ Found ${schemas.length} schemas:`, { schemas });
  
  // Test 4: Get schema for /telemetry endpoint
  const telemetrySchema = getSchemaForEndpoint(openspec, 'post', '/telemetry');
  if (telemetrySchema) {
    logger.info('✅ Retrieved schema for /telemetry');
    logger.debug('Schema structure:', { 
      hasRef: !!telemetrySchema.$ref,
      ref: telemetrySchema.$ref 
    });
  } else {
    logger.error('❌ Could not get schema for /telemetry');
    process.exit(1);
  }
  
  // Test 5: Resolve $ref references
  const resolvedSchema = resolveRefs(telemetrySchema, openspec);
  if (resolvedSchema && resolvedSchema.properties) {
    logger.info('✅ $ref resolution works');
    logger.debug('Resolved schema properties:', { 
      properties: Object.keys(resolvedSchema.properties),
      required: resolvedSchema.required 
    });
  } else {
    logger.error('❌ $ref resolution failed');
    process.exit(1);
  }
  
  // Test 6: Check specific fields
  if (resolvedSchema.properties.user_id) {
    logger.info('✅ user_id field exists in schema', {
      type: resolvedSchema.properties.user_id.type,
      format: resolvedSchema.properties.user_id.format
    });
  }
  
  if (resolvedSchema.properties.events) {
    logger.info('✅ events field exists in schema', {
      type: resolvedSchema.properties.events.type,
      isArray: resolvedSchema.properties.events.type === 'array'
    });
  }
  
  // Test 7: Get schema for /signals/current endpoint
  const signalsSchema = getSchemaForEndpoint(openspec, 'get', '/signals/current');
  if (signalsSchema) {
    logger.info('✅ Retrieved schema for /signals/current (GET)');
  }
  
  // Test 8: Get schema for /health endpoint
  const healthSchema = getSchemaForEndpoint(openspec, 'get', '/health');
  if (healthSchema === null) {
    logger.info('✅ /health has no body schema (expected for health check)');
  }
  
  logger.info('=== All OpenSpec Configuration Tests Passed! ===');
  logger.info('');
  logger.info('📋 Summary:');
  logger.info(`  - OpenSpec loaded from file`);
  logger.info(`  - ${paths.length} endpoints defined`);
  logger.info(`  - ${schemas.length} schemas defined`);
  logger.info(`  - $ref resolution working`);
  logger.info(`  - Ready for use in middleware!`);
  logger.info('');
  logger.info('✅ You can now proceed to Ticket #4!');
  
  process.exit(0);
}

testOpenSpecConfiguration();
