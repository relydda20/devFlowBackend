# OpenSpec Technical Specification

**Version:** 1.0  
**Status:** Living Document  
**Last Updated:** May 2026  

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Module Specifications](#module-specifications)
3. [API Specifications](#api-specifications)
4. [Data Types](#data-types)
5. [Error Specifications](#error-specifications)
6. [Performance Specifications](#performance-specifications)
7. [Security Specifications](#security-specifications)

---

## System Overview

### Purpose
Provide automatic API validation using OpenAPI 3.0 specification as single source of truth.

### Scope
- ✅ Request body validation
- ✅ Schema resolution ($ref handling)
- ✅ Error message generation
- ❌ Response validation (future)
- ❌ Query parameter validation (future)
- ❌ Header validation (future)

### Technology Stack
- **Specification Format:** OpenAPI 3.0 (YAML)
- **Validator:** AJV 8.12.0
- **Parser:** js-yaml 4.1.0
- **Runtime:** Node.js 18+ (ES Modules)

---

## Module Specifications

### 1. OpenSpec Configuration Module

**File:** `src/config/openspec.js`

#### Module Exports

```typescript
interface OpenSpecConfig {
  // The loaded OpenSpec object
  openspec: OpenAPISpec;
  
  // Resolve $ref references
  resolveRefs(schema: any, spec: OpenAPISpec): any;
  
  // Get schema for specific endpoint
  getSchemaForEndpoint(
    spec: OpenAPISpec, 
    method: string, 
    path: string
  ): JSONSchema | null;
}
```

#### Function: `loadOpenSpec()`

**Signature:**
```javascript
function loadOpenSpec(): OpenAPISpec
```

**Description:** Loads and parses openspec.yaml file from filesystem.

**Returns:** Parsed OpenSpec object

**Throws:**
- `Error` if file not found
- `Error` if YAML parsing fails
- `Error` if required fields missing

**Side Effects:**
- Logs success/failure to logger
- Process exits on fatal errors

**Performance:** O(n) where n = file size. Typically 10-50ms.

**Example:**
```javascript
const openspec = loadOpenSpec();
// Returns: { openapi: '3.0.0', paths: {...}, components: {...} }
```

---

#### Function: `resolveRefs()`

**Signature:**
```javascript
function resolveRefs(schema: any, spec: OpenAPISpec): any
```

**Description:** Recursively resolves `$ref` references in JSON schema.

**Parameters:**
- `schema` - The schema object (may contain $refs)
- `spec` - The full OpenSpec object (for lookups)

**Returns:** Resolved schema with all $refs replaced

**Throws:**
- `Error` if $ref points to non-existent path

**Algorithm:**
```
1. If schema has $ref:
   a. Split $ref by '/'
   b. Navigate spec object
   c. Return resolved schema (recursive)
2. If schema is object/array:
   a. Recursively resolve each property
   b. Return resolved object/array
3. Otherwise:
   a. Return schema as-is
```

**Time Complexity:** O(n*m) where:
- n = number of $refs
- m = average depth of ref paths

**Space Complexity:** O(d) where d = max recursion depth

**Example:**
```javascript
// Input
const schema = { $ref: '#/components/schemas/User' };

// Output
const resolved = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' }
  }
};
```

---

#### Function: `getSchemaForEndpoint()`

**Signature:**
```javascript
function getSchemaForEndpoint(
  spec: OpenAPISpec,
  method: string,
  path: string
): JSONSchema | null
```

**Description:** Extracts request body schema for specific endpoint.

**Parameters:**
- `spec` - The full OpenSpec object
- `method` - HTTP method (post, get, put, etc.)
- `path` - API path (e.g., '/telemetry')

**Returns:** 
- JSON Schema object if found
- `null` if endpoint/method not found

**Throws:** Never throws (returns null on error)

**Side Effects:** Logs warning if schema not found

**Example:**
```javascript
const schema = getSchemaForEndpoint(openspec, 'post', '/telemetry');
// Returns: { $ref: '#/components/schemas/TelemetryBatch' }
```

---

### 2. Validation Middleware Module

**File:** `src/middleware/validation.middleware.js`

#### Module Exports

```typescript
interface ValidationMiddleware {
  // Create validation middleware for endpoint
  validateRequest(apiPath: string): ExpressMiddleware;
}
```

#### Function: `validateRequest()`

**Signature:**
```javascript
function validateRequest(apiPath: string): (req, res, next) => void
```

**Description:** Creates Express middleware that validates requests against OpenSpec.

**Parameters:**
- `apiPath` - The API path to validate (e.g., '/telemetry')

**Returns:** Express middleware function

**Behavior:**
1. Get schema from OpenSpec
2. Resolve $refs
3. Compile with AJV
4. Validate req.body
5. If valid → call next()
6. If invalid → return 400 with errors

**Performance:** 
- First request: ~5ms (compilation)
- Subsequent requests: <1ms (cached)

**Example:**
```javascript
router.post('/telemetry',
  validateRequest('/telemetry'),
  controller.submitTelemetry
);
```

---

## API Specifications

### Validation Request Format

**Input:** Express request object with `req.body`

**Output:** 
- Success: calls `next()`
- Failure: returns JSON error response

### Error Response Format

```typescript
interface ValidationError {
  error: 'Validation failed';
  message: string;
  details: AJVError[];
}

interface AJVError {
  instancePath: string;    // Path to invalid field
  schemaPath: string;      // Path in schema
  keyword: string;         // Validation rule that failed
  params: object;          // Additional context
  message: string;         // Human-readable message
}
```

**HTTP Status Code:** 400 Bad Request

**Example:**
```json
{
  "error": "Validation failed",
  "message": "Request body does not match required schema",
  "details": [
    {
      "instancePath": "/user_id",
      "schemaPath": "#/properties/user_id/format",
      "keyword": "format",
      "params": { "format": "uuid" },
      "message": "must match format \"uuid\""
    }
  ]
}
```

---

## Data Types

### OpenAPI Specification Object

```typescript
interface OpenAPISpec {
  openapi: '3.0.0';
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{
    url: string;
    description?: string;
  }>;
  paths: {
    [path: string]: {
      [method: string]: {
        summary?: string;
        operationId?: string;
        requestBody?: {
          required?: boolean;
          content: {
            'application/json': {
              schema: JSONSchema;
            };
          };
        };
        responses: {
          [statusCode: string]: {
            description: string;
            content?: {
              'application/json': {
                schema: JSONSchema;
              };
            };
          };
        };
      };
    };
  };
  components?: {
    schemas?: {
      [schemaName: string]: JSONSchema;
    };
  };
}
```

### JSON Schema Object

```typescript
interface JSONSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  $ref?: string;
  properties?: {
    [propertyName: string]: JSONSchema;
  };
  items?: JSONSchema;
  required?: string[];
  enum?: any[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchema;
}
```

### Supported Formats

| Format | Description | Example |
|--------|-------------|---------|
| `date-time` | ISO 8601 date-time | `2024-05-12T10:00:00Z` |
| `date` | ISO 8601 date | `2024-05-12` |
| `time` | ISO 8601 time | `10:00:00` |
| `email` | Email address | `user@example.com` |
| `uuid` | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` |
| `uri` | URI/URL | `https://example.com` |
| `ipv4` | IPv4 address | `192.168.1.1` |
| `ipv6` | IPv6 address | `::1` |

---

## Error Specifications

### Error Categories

#### 1. Configuration Errors (Fatal)

**When:** During application startup  
**Behavior:** Application exits  
**Logging Level:** ERROR

| Error | Cause | Solution |
|-------|-------|----------|
| `OpenSpec file not found` | Missing openspec.yaml | Create file in project root |
| `OpenSpec parsing failed` | Invalid YAML syntax | Fix YAML syntax errors |
| `Invalid OpenSpec structure` | Missing required fields | Add paths/components |

#### 2. Resolution Errors (Fatal)

**When:** During schema resolution  
**Behavior:** Return 500  
**Logging Level:** ERROR

| Error | Cause | Solution |
|-------|-------|----------|
| `Could not resolve $ref: X` | $ref points to non-existent schema | Fix $ref path in OpenSpec |

#### 3. Validation Errors (Expected)

**When:** During request validation  
**Behavior:** Return 400  
**Logging Level:** WARN

| Keyword | Meaning | Example |
|---------|---------|---------|
| `required` | Missing required field | `user_id` not provided |
| `type` | Wrong data type | Number instead of string |
| `format` | Invalid format | Invalid UUID format |
| `enum` | Value not in enum | `priority` not in [low, medium, high] |
| `minLength` | String too short | Password less than 8 chars |
| `maxLength` | String too long | Description over 1000 chars |
| `minimum` | Number too small | Age less than 0 |
| `maximum` | Number too large | Age over 150 |
| `pattern` | Doesn't match regex | Phone number format invalid |

---

## Performance Specifications

### Latency Requirements

| Operation | Target | Maximum |
|-----------|--------|---------|
| Load OpenSpec | <50ms | 100ms |
| Resolve $ref | <1ms | 5ms |
| Compile schema | <10ms | 20ms |
| Validate request | <1ms | 2ms |

### Throughput Requirements

| Metric | Target |
|--------|--------|
| Requests per second | 1000+ |
| Concurrent validations | 100+ |
| Memory usage per validation | <1KB |

### Scalability

- **Horizontal:** Stateless, scales linearly with instances
- **Vertical:** O(1) memory per request after compilation
- **Caching:** AJV caches compiled validators automatically

### Performance Optimization Checklist

- [x] Load OpenSpec once at startup
- [x] Cache resolved schemas
- [x] AJV compilation caching enabled
- [ ] Add caching layer for resolved schemas (future)
- [ ] Add performance monitoring (future)

---

## Security Specifications

### Input Validation

**What is Validated:**
- ✅ Data types (string, number, boolean, etc.)
- ✅ Required fields
- ✅ Format validation (uuid, email, date-time)
- ✅ Length constraints (min/max)
- ✅ Numeric ranges (minimum/maximum)
- ✅ Enum values (whitelists)
- ✅ Pattern matching (regex)

**What is NOT Validated:**
- ❌ Business logic (use services)
- ❌ Authentication (use auth middleware)
- ❌ Authorization (use permission checks)
- ❌ SQL injection (use parameterized queries)
- ❌ XSS (use output encoding)
- ❌ CSRF (use tokens)

### Security Best Practices

#### 1. Use Strict Types
```yaml
# ✅ GOOD
status:
  type: string
  enum: [active, inactive]

# ❌ BAD
status:
  type: string  # Any string allowed
```

#### 2. Limit String Lengths
```yaml
# ✅ GOOD
description:
  type: string
  maxLength: 1000

# ❌ BAD
description:
  type: string  # Unlimited length (DoS risk)
```

#### 3. Validate Formats
```yaml
# ✅ GOOD
email:
  type: string
  format: email

# ❌ BAD
email:
  type: string  # No format validation
```

#### 4. Require Critical Fields
```yaml
# ✅ GOOD
required:
  - user_id
  - timestamp

# ❌ BAD
required: []  # Everything optional
```

#### 5. Prevent Additional Properties
```yaml
# ✅ GOOD (strict)
additionalProperties: false

# ⚠️ OKAY (permissive)
additionalProperties: true

# Choose based on use case
```

---

## Compliance

### Standards Compliance

- ✅ **OpenAPI 3.0.0** - Full compliance
- ✅ **JSON Schema Draft 7** - AJV supports
- ✅ **RFC 3339** - Date-time format
- ✅ **RFC 4122** - UUID format
- ✅ **RFC 5322** - Email format

### Coding Standards

- ✅ **ES Modules** - Modern JavaScript
- ✅ **JSDoc comments** - Function documentation
- ✅ **Error handling** - All edge cases covered
- ✅ **Logging** - Winston structured logging
- ✅ **Testing** - Automated test coverage

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | development | Environment mode |
| `LOG_LEVEL` | info | Logging verbosity |

### File Locations

| File | Location | Purpose |
|------|----------|---------|
| OpenSpec | `./openspec.yaml` | API specification |
| Config | `src/config/openspec.js` | Loader module |
| Middleware | `src/middleware/validation.middleware.js` | Validation |

---

## Testing Specifications

### Unit Tests

**Coverage Target:** 100%

**Test Cases:**
- [x] loadOpenSpec() with valid file
- [x] loadOpenSpec() with missing file
- [x] loadOpenSpec() with invalid YAML
- [x] resolveRefs() with simple $ref
- [x] resolveRefs() with nested $refs
- [x] resolveRefs() with circular refs (error)
- [x] getSchemaForEndpoint() success
- [x] getSchemaForEndpoint() not found
- [x] validateRequest() valid data
- [x] validateRequest() invalid data
- [x] validateRequest() missing required
- [x] validateRequest() wrong type
- [x] validateRequest() invalid format

### Integration Tests

**Test Cases:**
- [x] POST /telemetry with valid body (200)
- [x] POST /telemetry with invalid body (400)
- [x] Error response format correct
- [x] Error details helpful
- [x] Multiple errors returned
- [x] Performance acceptable

### Load Tests

**Performance Targets:**
- [ ] 1000 req/s sustained
- [ ] <1ms p50 validation latency
- [ ] <2ms p99 validation latency
- [ ] <100MB memory usage

---

## Maintenance

### Regular Tasks
- **Monthly:** Review OpenSpec for accuracy
- **Per Release:** Update schemas for API changes
- **As Needed:** Optimize performance
- **As Needed:** Update AJV version

### Monitoring
- **Metrics:** Validation failures per endpoint
- **Alerts:** High error rate (>10%)
- **Logging:** All validation failures logged

---

## Glossary

| Term | Definition |
|------|------------|
| **OpenSpec** | OpenAPI Specification 3.0 |
| **AJV** | Another JSON Validator library |
| **$ref** | JSON Schema reference to another schema |
| **Schema** | JSON Schema definition of data structure |
| **Validator** | Compiled AJV validation function |
| **Middleware** | Express function that processes requests |

---

**Document Status:** ✅ Complete  
**Maintained By:** Backend Team  
**Review Frequency:** Quarterly  
**Next Review:** August 2026
