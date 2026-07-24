# Primitives API - Dual Authentication Guide

## Overview

The Primitives API now supports **dual authentication**, allowing clients to authenticate using either:
1. **JWT Tokens** (from NextAuth sessions)
2. **API Keys** (tenant-level access)

## Authentication Methods

### 1. JWT Token Authentication

**Use Case**: When users are logged in via the NextAuth session in the UI.

**How It Works**:
- JWT token is passed in the `Authorization` header as a Bearer token
- Token is validated using the same secret as NextAuth (`BETTER_AUTH_SECRET`)
- User ID is extracted from the token (`user_id` or `sub` claim)
- System verifies the user belongs to the requested tenant via `tenant_users` table
- The `created_by` field is automatically set to the authenticated user

**Example**:
```bash
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  http://localhost:8000/v1/primitives/my-tenant
```

**Benefits**:
- User attribution (tracks who created/modified primitives)
- Seamless integration with NextAuth sessions
- No need to manage separate API keys for UI users

### 2. API Key Authentication

**Use Case**: For programmatic access, CI/CD pipelines, external integrations.

**How It Works**:
- API key is passed in the `X-API-Key` header
- System validates the key exists, is not expired, and is enabled
- System verifies the key belongs to the requested tenant
- The `created_by` field will be NULL (tenant-level operation)

**Example**:
```bash
curl -H "X-API-Key: your-api-key" \
  http://localhost:8000/v1/primitives/my-tenant
```

**Benefits**:
- No user session required
- Long-lived access for automation
- Tenant-level permissions

## Configuration

### Environment Variables

Add to your `.env` file in `apiome-rest`:

```bash
# JWT Configuration (must match NextAuth secret)
BETTER_AUTH_SECRET=your-nextauth-secret-here
JWT_SECRET=your-nextauth-secret-here  # Alternative name
JWT_ALGORITHM=HS256

# Database connection
DATABASE_URL=postgresql://user:password@localhost:5432/apiome
```

**Important**: The `BETTER_AUTH_SECRET` or `JWT_SECRET` must match the secret configured in your NextAuth setup in `apiome-ui`.

## JWT Token Structure

The JWT token from NextAuth should contain these claims:

```json
{
  "user_id": "uuid-of-user",      // Required
  "sub": "uuid-of-user",          // Alternative to user_id
  "email": "user@example.com",    // Optional
  "name": "User Name",            // Optional
  "iat": 1234567890,              // Issued at
  "exp": 1234567890               // Expiration
}
```

## Authentication Flow

### JWT Flow

1. Client sends request with `Authorization: Bearer <token>` header
2. `auth.py` extracts and decodes the JWT
3. Validates token signature using `BETTER_AUTH_SECRET`
4. Extracts `user_id` from token
5. Queries `tenant_users` table to verify user belongs to tenant
6. Returns authentication data with user information

### API Key Flow

1. Client sends request with `X-API-Key: <key>` header
2. `auth.py` validates the API key exists and is active
3. Verifies the key's tenant matches the requested tenant
4. Returns authentication data without user information

### Priority

If both headers are provided, **JWT authentication takes precedence**.

## Code Examples

### Using JWT Token (from Next.js)

```typescript
// In a Next.js API route or server component
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user?.user_id) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  // Get the JWT token from the session
  const token = await getToken({ req: request });
  
  // Call the primitives API
  const response = await fetch('http://localhost:8000/v1/primitives/my-tenant', {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  
  return response;
}
```

### Using API Key (programmatic access)

```python
import requests

API_KEY = "your-api-key"
TENANT_SLUG = "my-tenant"
BASE_URL = "http://localhost:8000"

# List primitives
response = requests.get(
    f"{BASE_URL}/v1/primitives/{TENANT_SLUG}",
    headers={"X-API-Key": API_KEY}
)
primitives = response.json()

# Create primitive
response = requests.post(
    f"{BASE_URL}/v1/primitives/{TENANT_SLUG}",
    headers={"X-API-Key": API_KEY},
    json={
        "name": "EmailAddress",
        "description": "A valid email address",
        "category": "string",
        "schema": {
            "type": "string",
            "format": "email"
        },
        "tags": ["email", "contact"]
    }
)
```

## Error Handling

### Common Errors

**401 Unauthorized - No Authentication**
```json
{
  "detail": "Authentication required. Provide either JWT token (Authorization: Bearer <token>) or API key (X-API-Key: <key>)"
}
```

**401 Unauthorized - Invalid JWT**
```json
{
  "detail": "Invalid JWT token: missing user identifier"
}
```

**401 Unauthorized - Invalid API Key**
```json
{
  "detail": "Invalid or expired API key"
}
```

**403 Forbidden - User Not in Tenant**
```json
{
  "detail": "User does not have access to tenant: my-tenant"
}
```

**403 Forbidden - API Key Wrong Tenant**
```json
{
  "detail": "API key does not have access to this tenant"
}
```

## Database Schema

### User-Tenant Relationship

```sql
-- Users belong to tenants via this table
CREATE TABLE tenant_users (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, user_id)
);
```

JWT authentication uses this table to verify that the authenticated user has access to the requested tenant.

## Testing

### Test JWT Authentication

```bash
# Generate a test JWT (requires jwt-cli or similar)
# Using Python
python3 << EOF
import jwt
import datetime

secret = "your-nextauth-secret"
payload = {
    "user_id": "user-uuid-here",
    "email": "test@example.com",
    "name": "Test User",
    "iat": datetime.datetime.utcnow(),
    "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=1)
}

token = jwt.encode(payload, secret, algorithm="HS256")
print(token)
EOF

# Use the token
curl -H "Authorization: Bearer <generated-token>" \
  http://localhost:8000/v1/primitives/my-tenant
```

### Test API Key Authentication

```bash
# Use existing API key
curl -H "X-API-Key: your-api-key" \
  http://localhost:8000/v1/primitives/my-tenant
```

## Migration from API Key Only

If you have existing code using API keys, **no changes are required**. The API key authentication continues to work exactly as before.

To add JWT authentication support to your UI:

1. Ensure `BETTER_AUTH_SECRET` is set in `apiome-rest/.env`
2. Extract JWT from NextAuth session
3. Pass JWT in `Authorization: Bearer` header instead of API key

## Troubleshooting

### JWT Token Not Working

1. **Check the secret matches**: Verify `BETTER_AUTH_SECRET` in both `apiome-ui` and `apiome-rest` are identical
2. **Check token expiration**: JWT tokens expire, ensure the token is still valid
3. **Check user-tenant relationship**: Verify the user is in the `tenant_users` table for the requested tenant

### API Key Not Working

1. **Check key is enabled**: Verify `enabled = true` in `api_keys` table
2. **Check expiration**: Verify `expires_at` is NULL or in the future
3. **Check tenant match**: Verify the key's `tenant_id` matches the requested tenant

### Getting User Attribution

When using JWT authentication, the `created_by` field will be automatically populated:

```bash
# Create with JWT (created_by will be set)
curl -X POST \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","category":"string","schema":{"type":"string"}}' \
  http://localhost:8000/v1/primitives/my-tenant

# Create with API Key (created_by will be NULL)
curl -X POST \
  -H "X-API-Key: <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","category":"string","schema":{"type":"string"}}' \
  http://localhost:8000/v1/primitives/my-tenant
```

## Best Practices

1. **Use JWT for UI**: When users are authenticated via NextAuth, use JWT tokens for better attribution
2. **Use API Keys for automation**: For CI/CD, scripts, and external integrations, use API keys
3. **Rotate API keys regularly**: Implement key rotation policies for security
4. **Set API key expiration**: Use the `expires_at` field to automatically expire old keys
5. **Monitor usage**: Track which authentication method is being used via the `auth_method` field in responses

## Implementation Details

All authentication logic is in `/Users/kenji/Development/apiome/apiome-rest/src/app/auth.py`:

- `decode_jwt()`: Decodes and validates JWT tokens
- `get_user_tenants()`: Gets all tenants for a user
- `validate_user_tenant_access()`: Verifies user-tenant relationship
- `validate_authentication()`: Main authentication dependency (tries JWT first, then API key)
- `get_authenticated_user_id()`: Extracts user ID from auth data
