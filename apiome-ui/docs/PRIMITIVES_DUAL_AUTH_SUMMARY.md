# Primitives API - Dual Authentication Implementation Summary

## Date
January 22, 2026

## Overview
Successfully enhanced the Primitives REST API to support dual authentication methods:
1. **JWT Token Authentication** (from NextAuth sessions)
2. **API Key Authentication** (existing method)

This allows seamless integration with the UI (via JWT) while maintaining compatibility with existing API key-based integrations.

## Changes Made

### 1. Dependencies
**File**: `apiome-rest/requirements.txt`
- Added `pyjwt==2.8.0` for JWT token decoding and validation

### 2. Configuration
**File**: `apiome-rest/src/app/config.py`
- Added `jwt_secret`: JWT secret key (reads from `BETTER_AUTH_SECRET` or `JWT_SECRET` env var)
- Added `jwt_algorithm`: JWT algorithm (default: HS256)
- Configured to use the same secret as NextAuth for token validation

### 3. Authentication Module (NEW)
**File**: `apiome-rest/src/app/auth.py`

Created comprehensive authentication module with:

#### Functions:
- `decode_jwt(token)`: Decodes and validates JWT tokens
- `get_user_tenants(user_id)`: Retrieves all tenants for a user
- `validate_user_tenant_access(user_id, tenant_slug)`: Verifies user-tenant relationship
- `validate_authentication(tenant_slug, authorization, x_api_key)`: Main authentication dependency
- `get_authenticated_user_id(auth_data)`: Extracts user ID from auth data

#### Authentication Flow:
1. **JWT First**: If `Authorization: Bearer <token>` header exists:
   - Decode and validate JWT using BETTER_AUTH_SECRET
   - Extract user_id from token
   - Verify user belongs to tenant via `tenant_users` table
   - Return auth data with user information

2. **API Key Fallback**: If no JWT or JWT invalid, check `X-API-Key` header:
   - Validate API key exists and is active
   - Verify key belongs to requested tenant
   - Return auth data without user information

3. **Error**: If neither provided, return 401 with clear error message

### 4. Primitives Routes Updates
**File**: `apiome-rest/src/app/primitives_routes.py`

Updated all endpoints to use `Depends(validate_authentication)`:

#### Modified Endpoints:
- `GET /{tenant_slug}` - List primitives
- `GET /{tenant_slug}/{primitive_id}` - Get primitive
- `POST /{tenant_slug}` - Create primitive
- `PUT /{tenant_slug}/{primitive_id}` - Update primitive
- `DELETE /{tenant_slug}/{primitive_id}` - Delete primitive
- `POST /{tenant_slug}/import` - Import from JSON Schema

#### Key Changes:
- Removed `validate_tenant_access()` function
- Added `auth_data: Dict[str, Any] = Depends(validate_authentication)` to all endpoints
- Updated `created_by` field to use `get_authenticated_user_id(auth_data)` for JWT auth
- Simplified endpoint logic by using dependency injection

### 5. Tests
**File**: `apiome-rest/test_primitives_api.py`
- Updated test descriptions to reflect dual authentication
- Added test for invalid JWT token
- Added test for invalid API key
- Added test for both JWT and API key provided (JWT takes precedence)

### 6. Documentation

#### Updated Files:
1. **FEATURE_PRIMITIVES.md**
   - Added dual authentication section
   - Updated security section
   - Added JWT token structure documentation
   - Updated all curl examples to show both methods

2. **PRIMITIVES_QUICK_REFERENCE.md** (NEW)
   - Added environment configuration section
   - Separated JWT and API key examples
   - Added dependencies installation step

3. **PRIMITIVES_DUAL_AUTH_GUIDE.md** (NEW)
   - Comprehensive guide for dual authentication
   - Authentication flow diagrams
   - Code examples for both methods
   - Troubleshooting guide
   - Best practices
   - Migration guide from API key only

## Features

### ✅ JWT Token Authentication
- Validates user identity via NextAuth session
- Checks user-tenant membership via `tenant_users` table
- Automatically sets `created_by` field to authenticated user
- Seamless integration with UI

### ✅ API Key Authentication (Existing)
- Maintains backward compatibility
- Tenant-level access without user context
- `created_by` field is NULL for API key operations

### ✅ Security
- JWT tokens validated using same secret as NextAuth
- Token expiration checked automatically
- User-tenant relationship validated via database
- API key validation unchanged
- Both methods enforce tenant isolation

### ✅ User Attribution
- JWT auth: `created_by` populated with user ID
- API key auth: `created_by` is NULL
- Allows tracking who created/modified primitives when using JWT

## Configuration Requirements

### Environment Variables
Add to `apiome-rest/.env`:

```bash
# Must match the secret in apiome-ui NextAuth configuration
BETTER_AUTH_SECRET=your-nextauth-secret-here

# Alternative name (either works)
JWT_SECRET=your-nextauth-secret-here

# Algorithm (default is HS256)
JWT_ALGORITHM=HS256

# Database connection
DATABASE_URL=postgresql://user:password@localhost:5432/apiome
```

## Usage Examples

### From Next.js UI (JWT)
```typescript
const session = await getServerSession(authOptions);
const token = session?.accessToken; // or extract from cookies

const response = await fetch('http://localhost:8000/v1/primitives/my-tenant', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

### From External Script (API Key)
```bash
curl -H "X-API-Key: your-api-key" \
  http://localhost:8000/v1/primitives/my-tenant
```

## Testing

```bash
# Test JWT authentication
curl -H "Authorization: Bearer <jwt-token>" \
  http://localhost:8000/v1/primitives/test-tenant

# Test API key authentication
curl -H "X-API-Key: <api-key>" \
  http://localhost:8000/v1/primitives/test-tenant

# Run automated tests
cd apiome-rest
pytest test_primitives_api.py -v
```

## Database Schema Used

### tenant_users Table
```sql
CREATE TABLE tenant_users (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, user_id)
);
```

This table is queried during JWT authentication to verify the user has access to the requested tenant.

## Backward Compatibility

✅ **100% Backward Compatible**
- Existing API key integrations continue to work unchanged
- No breaking changes to API endpoints
- API key authentication flow identical to before

## Benefits

1. **Better User Attribution**: Track which user created/modified primitives
2. **Seamless UI Integration**: No need to manage API keys for UI users
3. **Flexible Access**: Support both user-level (JWT) and tenant-level (API key) access
4. **Security**: User-tenant relationship validated via database
5. **Backward Compatible**: Existing integrations continue to work

## Files Created/Modified

### Created:
- `apiome-rest/src/app/auth.py` - Authentication module
- `PRIMITIVES_DUAL_AUTH_GUIDE.md` - Comprehensive authentication guide

### Modified:
- `apiome-rest/requirements.txt` - Added PyJWT
- `apiome-rest/src/app/config.py` - Added JWT configuration
- `apiome-rest/src/app/primitives_routes.py` - Updated all endpoints
- `apiome-rest/test_primitives_api.py` - Updated tests
- `FEATURE_PRIMITIVES.md` - Updated documentation
- `PRIMITIVES_QUICK_REFERENCE.md` - Added dual auth examples

## Migration Steps

1. **Install dependencies**:
   ```bash
   cd apiome-rest
   pip install -r requirements.txt
   ```

2. **Configure environment**:
   ```bash
   # Add to .env
   echo "BETTER_AUTH_SECRET=your-nextauth-secret" >> .env
   ```

3. **Restart service**:
   ```bash
   uvicorn src.app.main:app --reload
   ```

4. **Test both methods**:
   ```bash
   # Test API key (should work as before)
   curl -H "X-API-Key: your-key" http://localhost:8000/v1/primitives/tenant
   
   # Test JWT (new)
   curl -H "Authorization: Bearer your-jwt" http://localhost:8000/v1/primitives/tenant
   ```

## Next Steps (Optional Enhancements)

- [ ] Add JWT refresh token support
- [ ] Implement rate limiting per authentication method
- [ ] Add audit logging for authentication events
- [ ] Create UI for managing API keys
- [ ] Add API key scopes/permissions
- [ ] Implement OAuth2 flows for external integrations

## Status

✅ **COMPLETE** - Dual authentication is fully implemented and tested.

All primitives endpoints now support both JWT and API key authentication with proper user-tenant validation.
