import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { openspec, resolveRefs, getSchemaForEndpoint } from '../config/openspec.js';
import logger from '../utils/logger.js';

// Initialize AJV with formats (for date-time, uuid, etc.)
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

/**
 * Create validation middleware for a specific endpoint
 * 
 * Usage:
 *   router.post('/telemetry', validateRequest('/telemetry'), controller)
 * 
 * This will automatically:
 * 1. Get the schema from OpenSpec
 * 2. Resolve any $ref references
 * 3. Validate incoming requests
 * 4. Return detailed errors if validation fails
 */
export function validateRequest(apiPath) {
  return (req, res, next) => {
    // Get schema from OpenSpec
    const schema = getSchemaForEndpoint(openspec, 'post', apiPath);
    
    if (!schema) {
      logger.warn(`No validation schema found for ${apiPath}`);
      return next();
    }

    // Resolve $ref references
    const resolvedSchema = resolveRefs(schema, openspec);
    
    // Compile and validate
    const validate = ajv.compile(resolvedSchema);
    const valid = validate(req.body);

    if (!valid) {
      logger.warn('Validation failed', { 
        path: apiPath, 
        errors: validate.errors 
      });
      
      return res.status(400).json({
        error: 'Validation failed',
        message: 'Request body does not match required schema',
        details: validate.errors
      });
    }

    // ✅ Validation passed!
    next();
  };
}
