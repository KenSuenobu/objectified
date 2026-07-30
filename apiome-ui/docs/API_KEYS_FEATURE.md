# API Keys Management Feature

## Overview

The API Keys management feature allows users to create, manage, and revoke API keys for accessing tenant data via external REST API services. This feature provides secure authentication for programmatic access to the Apiome platform.

## Database Schema

### Table: `api_keys`

Located in the `apiome` schema, the `api_keys` table stores API key information with the following structure:

**Columns:**
- `id` (UUID): Primary key, unique identifier for the API key
- `tenant_id` (UUID): Foreign key reference to `tenants(id)`, associates the key with a specific tenant
- `name` (VARCHAR(255)): Human-readable name for the API key
- `description` (TEXT): Optional description of the API key's purpose
- `key_hash` (VARCHAR(255)): Bcrypt-hashed version of the API key for secure storage
- `key_prefix` (VARCHAR(20)): First 12 characters of the key + "..." for display purposes
- `last_used_at` (TIMESTAMP): Timestamp when the API key was last used
- `expires_at` (TIMESTAMP): Optional expiration date (NULL = never expires)
- `enabled` (BOOLEAN): Flag to enable/disable the key without deletion
- `deleted_at` (TIMESTAMP): Soft delete timestamp (NULL = not deleted)
- `created_at` (TIMESTAMP): Creation timestamp
- `updated_at` (TIMESTAMP): Last update timestamp

**Constraints:**
- `api_keys_tenant_name_unique`: Ensures API key names are unique within each tenant
- Foreign key constraint with CASCADE delete on tenant deletion

**Indexes:**
- `idx_api_keys_tenant_id`: Fast lookup by tenant
- `idx_api_keys_key_hash`: Fast validation of API keys
- `idx_api_keys_key_prefix`: Fast lookup by key prefix
- `idx_api_keys_enabled`: Filter by enabled status
- `idx_api_keys_deleted_at`: Support soft delete queries
- `idx_api_keys_expires_at`: Check expiration status
- `idx_api_keys_last_used_at`: Track usage patterns
- `idx_api_keys_created_at`: Sort by creation date

## Features

### 1. Create API Key
- Generate cryptographically secure API keys with `sk_` prefix
- Set optional expiration date (in days)
- Add descriptive name and description
- API key is shown only once upon creation
- Automatic hashing using bcrypt before storage

### 2. List API Keys
- View all API keys for the current tenant
- Display key prefix, last used date, expiration date, and status
- Visual indicators for expired and disabled keys
- Empty state with call-to-action for first-time users

### 3. Enable/Disable API Keys
- Toggle switch to enable or disable keys without deletion
- Maintains key history while controlling access
- Immediate effect on API authentication

### 4. Delete API Keys
- Soft delete with confirmation dialog
- Permanently revokes access
- Maintains audit trail through deleted_at timestamp

### 5. API Key Validation
- Validates API keys against stored hashes
- Checks expiration dates
- Verifies enabled status and tenant status
- Updates last_used_at timestamp on successful validation
- Returns tenant information on successful validation

## Security Features

1. **Secure Storage**: API keys are hashed using bcrypt before storage
2. **One-Time Display**: Full API key is shown only once at creation
3. **Key Prefix**: Only shows first 12 characters for identification
4. **Expiration Support**: Optional expiration dates for time-limited access
5. **Soft Delete**: Maintains audit trail of deleted keys
6. **Tenant Isolation**: Keys are scoped to specific tenants
7. **Enable/Disable**: Immediate access control without deletion

## API Key Format

API keys follow this format:
```
sk_[64 hexadecimal characters]
```

Example:
```
sk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2
```

## UI Components

### Location
`/ade/dashboard/api-keys`

### Navigation
Added to the Dashboard Side Navigation under the "Administration" section, alongside "Tenants".

### Pages Created
- `/src/app/ade/dashboard/api-keys/page.tsx`: Main API keys management page

### Key Components
1. **API Keys List**: Card-based display of all keys with details
2. **Create Modal**: Dialog for creating new API keys
3. **API Key Display Modal**: Secure one-time display of generated key
4. **Delete Confirmation Modal**: Confirms deletion with warning
5. **Status Toggle**: Switch component for enable/disable
6. **Empty State**: Guidance for first-time users

## Database Helper Functions

Located in `/lib/db/helper.ts`:

### `getApiKeysForTenant(tenantId: string)`
Retrieves all non-deleted API keys for a specific tenant.

### `createApiKey(tenantId: string, name: string, description: string, expiresInDays: number | null)`
Creates a new API key with optional expiration. Returns the plain-text key (only time it's visible).

### `deleteApiKey(apiKeyId: string)`
Soft deletes an API key by setting `deleted_at` timestamp.

### `toggleApiKeyStatus(apiKeyId: string, enabled: boolean)`
Enables or disables an API key.

### `updateApiKeyLastUsed(apiKeyId: string)`
Updates the `last_used_at` timestamp for tracking usage.

### `validateApiKey(apiKey: string)`
Validates an API key against stored hashes. Returns tenant information on success.

## Migration Script

**File**: `/apiome-db/scripts/20251108-220159.sql`

The migration script is fully idempotent and includes:
1. Creates `visibility_type` enum (if not exists)
2. Adds `visibility` column to `versions` table (if not exists)
3. Creates `api_keys` table (if not exists)
4. Adds comprehensive comments for documentation
5. Creates all necessary indexes (if not exist)

To run the migration:
```sql
psql -U your_user -d your_database -f apiome-db/scripts/20251108-220159.sql
```

## Usage Example

### Creating an API Key via UI
1. Navigate to Dashboard > API Keys
2. Click "Create API Key" button
3. Fill in name and optional description
4. Set expiration (optional)
5. Click "Create"
6. Copy the displayed API key (shown only once)
7. Store securely in your application

### Using an API Key (Future Implementation)
```javascript
// Example REST API call
fetch('https://api.apiome.dev/v1/data', {
  headers: {
    'Authorization': 'Bearer sk_...',
    'Content-Type': 'application/json'
  }
})
```

## Future Enhancements

1. **Scope/Permissions**: Add granular permissions to API keys
2. **Rate Limiting**: Track and limit API calls per key
3. **Usage Analytics**: Detailed usage statistics and graphs
4. **Rotation**: Automatic key rotation before expiration
5. **IP Whitelisting**: Restrict keys to specific IP addresses
6. **Webhooks**: API key expiration notifications
7. **Multiple Scopes**: Project-specific or version-specific keys

## Testing Checklist

- [ ] Create API key with name and description
- [ ] Create API key with expiration date
- [ ] Copy generated API key to clipboard
- [ ] View list of API keys for tenant
- [ ] Enable/disable API key toggle
- [ ] Delete API key with confirmation
- [ ] Verify soft delete (deleted_at set)
- [ ] Check expired key visual indicator
- [ ] Verify unique name constraint within tenant
- [ ] Test API key validation function
- [ ] Verify last_used_at updates on validation
- [ ] Test expiration date enforcement
- [ ] Verify tenant isolation (can't see other tenant's keys)

## Related Files

- `/apiome-db/scripts/20251108-220159.sql` - Database migration
- `/lib/db/helper.ts` - Database helper functions
- `/src/app/ade/dashboard/api-keys/page.tsx` - API Keys management UI
- `/src/app/components/ade/dashboard/DashboardSideNav.tsx` - Navigation component

