# JSON Schema Endpoints

## Overview

The Apiome REST API now includes JSON Schema endpoints under `/v1/json`. JSON Schema is a vocabulary that allows you to annotate and validate JSON documents. It uses the JSON Schema Draft 2020-12 specification.

These endpoints provide the same features and flexibility as OpenAPI and Arazzo endpoints, with complete parity for endpoint patterns and authentication.

## New Endpoints

### 1. Get Version JSON Schema Specification

**Endpoint:** `GET /v1/json/{tenant-slug}/{project-slug}/{version-slug}`

**Description:** Retrieves the complete JSON Schema specification for all classes in a version.

**Parameters:**
- `tenant-slug` (path, required): The tenant identifier
- `project-slug` (path, required): The project identifier  
- `version-slug` (path, required): The version identifier (e.g., "1.0.0")
- `X-API-Key` (header, optional): API key for private versions
- `Accept` (header, optional): Content negotiation (application/json or application/yaml)

**Response Formats:**
- **JSON** (default): `application/json`
- **YAML**: Use Accept header with `application/yaml`, `application/x-yaml`, `text/yaml`, or `text/x-yaml`

**Example Request (JSON):**
```bash
curl -X GET "http://localhost:8000/v1/json/my-tenant/my-project/1.0.0" \
  -H "Accept: application/json"
```

**Example Request (YAML):**
```bash
curl -X GET "http://localhost:8000/v1/json/my-tenant/my-project/1.0.0" \
  -H "Accept: application/yaml"
```

**Example Request (Private Version):**
```bash
curl -X GET "http://localhost:8000/v1/json/my-tenant/my-project/1.0.0" \
  -H "X-API-Key: your-api-key-here" \
  -H "Accept: application/json"
```

**Example Response:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://apiome.dev/my-tenant/my-project/1.0.0/schema.json",
  "title": "my-project Schema",
  "description": "Generated JSON Schema from Apiome Studio - Version 1.0.0",
  "version": "1.0.0",
  "type": "object",
  "$defs": {
    "User": {
      "type": "object",
      "title": "User",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "email": {
          "type": "string",
          "format": "email"
        }
      },
      "required": ["id", "name"]
    },
    "Product": {
      "type": "object",
      "title": "Product",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "price": {
          "type": "number"
        }
      },
      "required": ["id", "name", "price"]
    }
  }
}
```

### 2. Get Class JSON Schema Specification

**Endpoint:** `GET /v1/json/{tenant-slug}/{project-slug}/{version-slug}/{class-name}`

**Description:** Retrieves the JSON Schema specification for a single class.

**Parameters:**
- `tenant-slug` (path, required): The tenant identifier
- `project-slug` (path, required): The project identifier
- `version-slug` (path, required): The version identifier (e.g., "1.0.0")
- `class-name` (path, required): The name of the class
- `X-API-Key` (header, optional): API key for private versions
- `Accept` (header, optional): Content negotiation (application/json or application/yaml)

**Response Formats:**
- **JSON** (default): `application/json`
- **YAML**: Use Accept header with `application/yaml`, `application/x-yaml`, `text/yaml`, or `text/x-yaml`

**Example Request (JSON):**
```bash
curl -X GET "http://localhost:8000/v1/json/my-tenant/my-project/1.0.0/User" \
  -H "Accept: application/json"
```

**Example Request (YAML):**
```bash
curl -X GET "http://localhost:8000/v1/json/my-tenant/my-project/1.0.0/User" \
  -H "Accept: application/yaml"
```

**Example Response:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://apiome.dev/my-tenant/my-project/1.0.0/User.json",
  "title": "User Schema",
  "description": "JSON Schema specification for my-tenant/my-project/1.0.0/User",
  "version": "1.0.0",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "email": {
      "type": "string",
      "format": "email"
    },
    "age": {
      "type": "integer",
      "minimum": 0
    }
  },
  "required": ["id", "name", "email"]
}
```

## JSON Schema Features

### Draft 2020-12 Compliance

The schemas use the JSON Schema Draft 2020-12 specification, which includes:

- **$schema** - References the official JSON Schema meta-schema
- **$id** - Unique identifier for the schema
- **$defs** - Named definitions for reusable schema fragments
- **title** - Human-readable schema title
- **description** - Schema documentation
- **type** - JSON data type specification
- **properties** - Object property definitions
- **required** - Required property list
- **additionalProperties** - Control for extra properties

### Schema Structure

#### Version-Level Schema
```
{
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "...",
  title: "Project Schema",
  version: "1.0.0",
  type: "object",
  $defs: {
    Class1: { ... },
    Class2: { ... },
    ...
  }
}
```

#### Class-Level Schema
```
{
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "...",
  title: "Class Schema",
  version: "1.0.0",
  type: "object",
  properties: { ... },
  required: [...]
}
```

## Content Negotiation

Both endpoints support content negotiation via the `Accept` header:

| Accept Header | Response Format | Content-Type | Filename Pattern |
|--------------|-----------------|--------------|------------------|
| `application/json` or `*/*` | JSON | `application/json` | N/A |
| `application/yaml` | YAML | `application/x-yaml` | `{project}-schema.yaml` or `{class}-schema.yaml` |
| `application/x-yaml` | YAML | `application/x-yaml` | Same as above |
| `text/yaml` | YAML | `application/x-yaml` | Same as above |
| `text/x-yaml` | YAML | `application/x-yaml` | Same as above |

## Authentication & Authorization

JSON Schema endpoints follow the same authentication rules as OpenAPI and Arazzo endpoints:

- **Public versions**: No authentication required
- **Private versions**: Require `X-API-Key` header
- API key must belong to the tenant being accessed

## Error Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 401 | Missing or invalid API key (for private versions) |
| 403 | Version not published or insufficient permissions |
| 404 | Tenant, project, version, or class not found |

## Use Cases

### 1. Data Validation
Use JSON Schema to validate JSON data before processing or storing it.

### 2. Documentation
Provide a standardized way to document JSON data structures.

### 3. Code Generation
Generate validator functions or classes from JSON Schema definitions.

### 4. API Testing
Use schemas with testing frameworks to validate API responses.

### 5. Data Transformation
Use schemas to guide data mapping and transformation operations.

### 6. Configuration Validation
Validate configuration files against schema specifications.

## Integration with Other Endpoints

JSON Schema specifications work alongside OpenAPI and Arazzo specs:

| Use Case | Endpoint |
|----------|----------|
| API documentation | `/v1/schema` (OpenAPI 3.1.0) |
| API workflows | `/v1/arazzo` (Arazzo 1.0.1) |
| JSON data validation | `/v1/json` (JSON Schema 2020-12) |
| Interactive docs | `/v1/swagger` (Swagger UI) |

## Example Workflow: Complete Data Validation

Here's how to use JSON Schema with other endpoints:

1. **Get the schema**
   ```bash
   curl http://localhost:8000/v1/json/tenant/project/1.0.0/User
   ```

2. **Validate data against schema**
   ```javascript
   const schema = response.json();
   const ajv = new Ajv();
   const validate = ajv.compile(schema);
   const valid = validate(userData);
   ```

3. **Reference in documentation**
   ```bash
   curl http://localhost:8000/v1/schema/tenant/project/1.0.0
   ```

4. **Use in workflows**
   ```bash
   curl http://localhost:8000/v1/arazzo/tenant/project/1.0.0
   ```

## Tools & Libraries

The JSON Schema specifications generated by this API are compatible with:

- [Ajv](https://ajv.js.org/) - JSON Schema validator for JavaScript
- [jsonschema](https://python-jsonschema.readthedocs.io/) - Python JSON Schema validator
- [json-schema-validator](https://github.com/networknt/json-schema-validator) - Java validator
- [JsonSchema.NET](https://github.com/gregsdennis/json-everything) - .NET validator
- [go-json-schema](https://github.com/xeipuuv/gojsonschema) - Go validator
- [Dataweave](https://docs.mulesoft.com/dataweave/latest/) - JSON transformation
- [Quicktype](https://quicktype.io/) - Code generation
- [JSON Schema Visual Editor](https://jsonschema.net/editor) - Schema editing

## API Reference Summary

The complete endpoint list includes:

```
Version-level specifications:
  /v1/schema/{tenant}/{project}/{version}           (OpenAPI)
  /v1/arazzo/{tenant}/{project}/{version}           (Arazzo)
  /v1/json/{tenant}/{project}/{version}             (JSON Schema)

Class-level specifications:
  /v1/schema/{tenant}/{project}/{version}/{class}   (OpenAPI)
  /v1/arazzo/{tenant}/{project}/{version}/{class}   (Arazzo)
  /v1/json/{tenant}/{project}/{version}/{class}     (JSON Schema)

Interactive documentation:
  /v1/swagger/{tenant}/{project}/{version}          (Swagger UI)

System:
  /                                                  (Discovery)
  /health                                           (Health Check)
```

## Notes

- All JSON Schema documents are validated against Draft 2020-12 specification
- Schemas use the same property definitions as OpenAPI specs for consistency
- $defs uses the modern keyword (instead of definitions)
- $id uses the Apiome naming convention for schema identification
- All nested and inline properties are fully resolved in schemas
- Supports composition patterns (allOf, anyOf, oneOf) from class definitions

---

**Last Updated:** December 7, 2024  
**JSON Schema Version:** Draft 2020-12  
**API Version:** 1.0.0

