import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import logger from '../utils/logger.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load and parse OpenSpec YAML file
 * This happens once at startup
 */
function loadOpenSpec() {
  try {
    const openspecPath = path.join(__dirname, '../../openspec.yaml');
    const fileContents = fs.readFileSync(openspecPath, 'utf8');
    const openspec = yaml.load(fileContents);
    
    logger.info('✅ OpenSpec loaded successfully', {
      endpoints: Object.keys(openspec.paths).length,
      schemas: Object.keys(openspec.components?.schemas || {}).length
    });
    
    return openspec;
  } catch (error) {
    logger.error('❌ Failed to load OpenSpec', { error: error.message });
    throw new Error(`OpenSpec loading failed: ${error.message}`);
  }
}

/**
 * Resolve $ref references in schemas
 * Example: { $ref: '#/components/schemas/User' }
 */
function resolveRefs(schema, spec) {
  if (!schema) return schema;
  
  // Handle $ref
  if (schema.$ref) {
    const refPath = schema.$ref.split('/').slice(1); // Remove '#'
    let resolved = spec;
    for (const part of refPath) {
      resolved = resolved[part];
      if (!resolved) {
        throw new Error(`Could not resolve $ref: ${schema.$ref}`);
      }
    }
    return resolveRefs(resolved, spec);
  }
  
  // Handle objects and arrays recursively
  if (typeof schema === 'object') {
    const resolved = Array.isArray(schema) ? [] : {};
    for (const key in schema) {
      resolved[key] = resolveRefs(schema[key], spec);
    }
    return resolved;
  }
  
  return schema;
}

/**
 * Get schema for a specific endpoint
 */
function getSchemaForEndpoint(openspec, method, path) {
  const pathConfig = openspec.paths[path];
  
  if (!pathConfig) {
    logger.warn(`No path configuration found for: ${path}`);
    return null;
  }
  
  if (!pathConfig[method]) {
    logger.warn(`No ${method.toUpperCase()} method found for: ${path}`);
    return null;
  }
  
  // Get request body schema
  if (method === 'post' || method === 'put' || method === 'patch') {
    const requestBody = pathConfig[method].requestBody;
    if (requestBody?.content?.['application/json']?.schema) {
      return requestBody.content['application/json'].schema;
    }
  }
  
  // Get query parameters schema
  if (method === 'get' || method === 'delete') {
    const parameters = pathConfig[method].parameters;
    if (parameters) {
      // Build schema from parameters
      return buildSchemaFromParameters(parameters);
    }
  }
  
  return null;
}

/**
 * Build JSON schema from OpenAPI parameters
 */
function buildSchemaFromParameters(parameters) {
  const schema = {
    type: 'object',
    required: [],
    properties: {}
  };
  
  for (const param of parameters) {
    if (param.required) {
      schema.required.push(param.name);
    }
    schema.properties[param.name] = param.schema;
  }
  
  return schema;
}

// Load OpenSpec once at module initialization
const openspec = loadOpenSpec();

// Export everything
export {
  openspec,
  resolveRefs,
  getSchemaForEndpoint
};

export default openspec;
