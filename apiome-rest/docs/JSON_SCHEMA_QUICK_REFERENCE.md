# JSON Schema Endpoints - Quick Reference

## Endpoint Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/json/{tenant}/{project}/{version}` | GET | Get all class schemas for a version |
| `/v1/json/{tenant}/{project}/{version}/{class}` | GET | Get schema for a single class |

## Quick Examples

### Get All Schemas (JSON)
```bash
curl http://localhost:8000/v1/json/my-tenant/my-project/1.0.0
```

### Get All Schemas (YAML)
```bash
curl -H "Accept: application/yaml" \
  http://localhost:8000/v1/json/my-tenant/my-project/1.0.0
```

### Get Single Class Schema (JSON)
```bash
curl http://localhost:8000/v1/json/my-tenant/my-project/1.0.0/User
```

### Get Single Class Schema (YAML)
```bash
curl -H "Accept: application/yaml" \
  http://localhost:8000/v1/json/my-tenant/my-project/1.0.0/User
```

### Private Version (with API Key)
```bash
curl -H "X-API-Key: your-api-key" \
  http://localhost:8000/v1/json/my-tenant/my-project/1.0.0
```

## Response Structure

### Complete Schema Document
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://apiome.dev/{tenant}/{project}/{version}/schema.json",
  "title": "Schema Title",
  "description": "Schema description",
  "version": "1.0.0",
  "type": "object",
  "$defs": {
    "ClassName": { ... }
  }
}
```

### Single Class Schema
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://apiome.dev/{tenant}/{project}/{version}/{class}.json",
  "title": "ClassName Schema",
  "version": "1.0.0",
  "type": "object",
  "properties": { ... },
  "required": [...]
}
```

## Schema Keywords

| Keyword | Purpose |
|---------|---------|
| `$schema` | Schema dialect identifier |
| `$id` | Unique schema identifier |
| `title` | Human-readable schema name |
| `description` | Schema documentation |
| `type` | JSON data type |
| `properties` | Object properties |
| `required` | Required properties |
| `additionalProperties` | Extra properties control |
| `$defs` | Reusable schema definitions |

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 401 | Missing/invalid API key |
| 403 | Not published or no access |
| 404 | Not found |

## Content Types

| Accept Header | Response Format |
|--------------|-----------------|
| `application/json` | JSON (default) |
| `application/yaml` | YAML |
| `application/x-yaml` | YAML |
| `text/yaml` | YAML |
| `text/x-yaml` | YAML |

## Testing

### Basic Test
```bash
# Get schemas
curl http://localhost:8000/v1/json/test-tenant/test-project/1.0.0

# Check response
echo $?  # Should be 0 for success
```

### Python Test
```python
import requests

response = requests.get(
    "http://localhost:8000/v1/json/my-tenant/my-project/1.0.0"
)
assert response.status_code == 200
schema = response.json()
assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
```

### With httpie
```bash
# JSON
http GET localhost:8000/v1/json/my-tenant/my-project/1.0.0

# YAML
http GET localhost:8000/v1/json/my-tenant/my-project/1.0.0 \
  Accept:application/yaml
```

## Common Patterns

### Download YAML File
```bash
curl -H "Accept: application/yaml" \
  http://localhost:8000/v1/json/my-tenant/my-project/1.0.0 \
  -o schemas.yaml
```

### Save JSON Response
```bash
curl http://localhost:8000/v1/json/my-tenant/my-project/1.0.0 \
  -o schemas.json
```

### Pretty Print JSON
```bash
curl http://localhost:8000/v1/json/my-tenant/my-project/1.0.0 | jq .
```

### List All Classes
```bash
curl http://localhost:8000/v1/json/my-tenant/my-project/1.0.0 | \
  jq '.["$defs"] | keys'
```

### Get Specific Class Definition
```bash
curl http://localhost:8000/v1/json/my-tenant/my-project/1.0.0 | \
  jq '.["$defs"]["User"]'
```

## Data Validation Example

### JavaScript (Ajv)
```javascript
import Ajv from 'ajv';

// Get schema
const response = await fetch('http://localhost:8000/v1/json/tenant/project/1.0.0/User');
const schema = await response.json();

// Create validator
const ajv = new Ajv();
const validate = ajv.compile(schema);

// Validate data
const data = { id: '123', name: 'John' };
const valid = validate(data);

if (!valid) {
  console.log('Validation errors:', validate.errors);
}
```

### Python
```python
import jsonschema
import requests

# Get schema
response = requests.get('http://localhost:8000/v1/json/tenant/project/1.0.0/User')
schema = response.json()

# Validate data
data = {'id': '123', 'name': 'John'}

try:
  jsonschema.validate(instance=data, schema=schema)
  print('Valid!')
except jsonschema.ValidationError as e:
  print('Invalid:', e.message)
```

## Integration Examples

### Use with Postman
1. Import as JSON Schema
2. Use for response validation
3. Generate test data

### Use with Newman (CLI)
```bash
newman run collection.json \
  --postman-api-key $POSTMAN_API_KEY
```

### Use with Code Generation
```bash
# Using Quicktype
curl http://localhost:8000/v1/json/tenant/project/1.0.0/User | \
  quicktype --lang typescript > types.ts
```

## Troubleshooting

### 404 Not Found
- Check tenant/project/version slugs are correct
- Verify version exists and is published

### 401 Unauthorized
- Add `X-API-Key` header for private versions
- Verify API key is valid and not expired

### 403 Forbidden
- Ensure version is published
- Check API key belongs to correct tenant

### Invalid YAML
- Verify Accept header spelling
- Try `application/yaml` explicitly

## Links

- [Full Documentation](JSON_SCHEMA_ENDPOINTS.md)
- [JSON Schema Spec](https://json-schema.org/)
- [OpenAPI Endpoints](./openapi_endpoints.md)
- [Arazzo Endpoints](./arazzo_endpoints.md)

---

**Last Updated:** December 7, 2024

