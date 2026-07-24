# Primitives Feature - Quick Reference

## Quick Start

### 1. Install Dependencies
```bash
cd apiome-rest
pip install -r requirements.txt
# or
uv pip install -r requirements.txt
```

### 2. Configure Environment
Create or update `apiome-rest/.env`:
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/apiome
BETTER_AUTH_SECRET=your-nextauth-secret-here  # Must match apiome-ui
JWT_ALGORITHM=HS256
```

### 3. Apply Database Migration
```bash
cd apiome-db
psql -d apiome -U postgres -f scripts/20260122-120000.sql
```

### 3. Apply Database Migration
```bash
cd apiome-db
psql -d apiome -U postgres -f scripts/20260122-120000.sql
```

### 2. Start the REST API
```bash
cd apiome-rest
uvicorn src.app.main:app --reload --port 8000
```

### 3. Test the API

#### Using JWT Token (from NextAuth)
```bash
# Get JWT token from your browser's NextAuth session or use test token
export JWT_TOKEN="your-jwt-token-here"

# List primitives
curl -H "Authorization: Bearer $JWT_TOKEN" \
  http://localhost:8000/v1/primitives/your-tenant-slug
```

#### Using API Key
```bash
# Get your API key from the database or UI first
export API_KEY="your-api-key-here"

# List primitives
curl -H "X-API-Key: $API_KEY" \
  http://localhost:8000/v1/primitives/your-tenant-slug
```

# Create a primitive
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Credit Card",
    "description": "A credit card number",
    "category": "string",
    "schema": {
      "type": "string",
      "pattern": "^[0-9]{13,19}$",
      "minLength": 13,
      "maxLength": 19
    },
    "tags": ["payment", "finance"]
  }' \
  http://localhost:8000/v1/primitives/your-tenant-slug

# Import from JSON Schema
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schema": {
      "$defs": {
        "EmailAddress": {
          "type": "string",
          "format": "email",
          "description": "Valid email address"
        },
        "PhoneNumber": {
          "type": "string",
          "pattern": "^\\+[1-9]\\d{1,14}$",
          "description": "E.164 phone number"
        }
      }
    },
    "import_all": true
  }' \
  http://localhost:8000/v1/primitives/your-tenant-slug/import
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/primitives/{tenant-slug}` | List all primitives |
| GET | `/v1/primitives/{tenant-slug}?category=string` | Filter by category |
| GET | `/v1/primitives/{tenant-slug}/{id}` | Get specific primitive |
| POST | `/v1/primitives/{tenant-slug}` | Create primitive |
| PUT | `/v1/primitives/{tenant-slug}/{id}` | Update primitive |
| DELETE | `/v1/primitives/{tenant-slug}/{id}` | Delete primitive |
| POST | `/v1/primitives/{tenant-slug}/import` | Import from JSON Schema |

## TypeScript Functions

```typescript
// In your Next.js server components or API routes
import { 
  getPrimitives, 
  createPrimitive, 
  importPrimitivesFromSchema 
} from '@/lib/db/helper';

// List primitives
const result = await getPrimitives(tenantId);
const { primitives } = JSON.parse(result);

// Create primitive
const result = await createPrimitive(
  tenantId,
  userId,
  'My Primitive',
  'Description',
  'string',
  { type: 'string', minLength: 1 },
  ['tag1', 'tag2']
);

// Import from JSON Schema
const result = await importPrimitivesFromSchema(
  tenantId,
  userId,
  jsonSchemaObject,
  ['def1', 'def2'] // optional, imports all if not provided
);
```

## Pre-installed System Primitives

| Name | Category | Description |
|------|----------|-------------|
| Email Address | string | RFC 5322 email format |
| UUID | string | Standard UUID format |
| Percentage | number | Number between 0-100 |
| URL | string | RFC 3986 URI format |
| ISO Date | string | YYYY-MM-DD format |
| ISO DateTime | string | ISO 8601 with timezone |
| Positive Integer | integer | Integer > 0 |
| Phone Number | string | E.164 format |

## Categories

- `string` - Text-based primitives
- `number` - Numeric primitives (decimal)
- `integer` - Whole number primitives
- `boolean` - True/false primitives
- `array` - Array-based primitives
- `object` - Object-based primitives

## Common JSON Schema Patterns

### String with Pattern
```json
{
  "type": "string",
  "pattern": "^[A-Z]{3}-\\d{6}$",
  "description": "Format: ABC-123456"
}
```

### Number with Range
```json
{
  "type": "number",
  "minimum": 0,
  "maximum": 100,
  "multipleOf": 0.01
}
```

### String with Enum
```json
{
  "type": "string",
  "enum": ["active", "inactive", "pending"],
  "description": "User status"
}
```

### Integer with Constraints
```json
{
  "type": "integer",
  "minimum": 1,
  "maximum": 100,
  "description": "Age in years"
}
```

## Troubleshooting

### "API key required"
- Ensure you're passing the `X-API-Key` header
- Check that your API key is valid and not expired

### "API key does not have access to this tenant"
- Verify the tenant slug matches your API key's tenant
- Check that the API key belongs to the correct tenant

### "Cannot update/delete system primitives"
- System primitives (is_system=true) are read-only
- Create a custom primitive instead

### "A primitive with that name already exists"
- Primitive names must be unique within a category for each tenant
- Use a different name or category

## Files Created/Modified

### Database
- `apiome-db/scripts/20260122-120000.sql`

### Python (apiome-rest)
- `src/app/models.py` (modified)
- `src/app/database.py` (modified)
- `src/app/primitives_routes.py` (new)
- `src/app/main.py` (modified)
- `test_primitives_api.py` (new)

### TypeScript (apiome-ui)
- `lib/db/helper.ts` (modified)

### Documentation
- `FEATURE_PRIMITIVES.md` (new)
- `FEATURE_PRIMITIVES_SUMMARY.md` (new)
- `PRIMITIVES_QUICK_REFERENCE.md` (this file)

## Next Steps

1. Run the database migration
2. Test the REST API endpoints
3. Build UI components for primitive management
4. Integrate with schema builder components
5. Add usage analytics

## Support

For questions or issues, refer to:
- Full documentation: `FEATURE_PRIMITIVES.md`
- Implementation summary: `FEATURE_PRIMITIVES_SUMMARY.md`
