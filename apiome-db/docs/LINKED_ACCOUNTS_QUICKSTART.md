# Linked Accounts - Quick Start Guide

## Prerequisites

- PostgreSQL database running
- Next.js application running
- GitHub OAuth app configured (get client ID and secret)

## Setup Steps

### 1. Run Database Migration

```bash
cd /Users/kenji/Development/apiome/apiome-db
psql -U your_postgres_user -d your_database_name -f scripts/20251121-external-auth-providers.sql
```

Expected output:
```
CREATE TABLE
CREATE INDEX
CREATE INDEX
...
CREATE TRIGGER
```

### 2. Configure GitHub OAuth

Add to `apiome-ui/.env.local`:
```env
GITHUB_ID=your_github_client_id_here
GITHUB_SECRET=your_github_client_secret_here
```

To get GitHub OAuth credentials:
1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - Application name: `Apiome (Local Dev)`
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/api/auth/oauth2/callback/github`
4. Click "Register application"
5. Copy Client ID and generate Client Secret

### 3. Restart the Application

```bash
cd /Users/kenji/Development/apiome/apiome-ui
npm run dev
```

### 4. Test the Feature

#### A. Test GitHub Login (First Time)

1. Navigate to: `http://localhost:3000/login`
2. Click "Sign in with GitHub"
3. Authorize the app on GitHub
4. You should be logged in and redirected to dashboard
5. Navigate to Dashboard → Linked Accounts
6. You should see your GitHub account listed as linked

#### B. Test Manual Account Linking

1. Log out
2. Create a new account using email/password
3. Log in with that account
4. Navigate to Dashboard → Linked Accounts
5. Click "Link" button next to GitHub
6. Authorize the app
7. You should see success message
8. Your GitHub account is now linked to this account too

**Note**: This will fail with "already linked" error if the GitHub account is already linked to another user.

#### C. Test Account Unlinking

1. While logged in, go to Dashboard → Linked Accounts
2. Click "Unlink" button next to your GitHub account
3. Confirm in the dialog
4. Account should be removed from the list
5. Log out and try logging in with GitHub again
6. It will auto-link again (if email matches)

## Verify Database

Check that the table exists:
```sql
SELECT table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'apiome' 
  AND table_name = 'external_auth_providers'
ORDER BY ordinal_position;
```

Check linked accounts:
```sql
SELECT 
  eap.id,
  eap.provider,
  eap.provider_username,
  eap.provider_email,
  u.name as user_name,
  u.email as user_email,
  eap.created_at,
  eap.last_login_at
FROM apiome.external_auth_providers eap
JOIN apiome.users u ON eap.user_id = u.id
ORDER BY eap.created_at DESC;
```

## Troubleshooting

### "User account not found" error on GitHub login

**Cause**: No user exists with that email address in `apiome.users`

**Solution**: Either:
1. Create a user account first with that email, OR
2. Modify the OAuth handler to auto-create users (not recommended for production)

### "This account is already linked" error

**Cause**: The GitHub account is already linked to another user

**Solution**:
1. Log in as the other user
2. Unlink the GitHub account
3. Try linking again

### GitHub OAuth redirects to error page

**Cause**: GitHub OAuth credentials not configured correctly

**Solution**:
1. Check `.env.local` has correct `GITHUB_ID` and `GITHUB_SECRET`
2. Verify callback URL in GitHub OAuth app matches: `http://localhost:3000/api/auth/oauth2/callback/github`
3. Restart Next.js server after changing .env.local

### "Not authenticated" error in console

**Cause**: Session not found when trying to link/unlink

**Solution**:
1. Make sure you're logged in
2. Check that NextAuth session is working correctly
3. Clear browser cookies and log in again

### Linked account doesn't appear in UI

**Cause**: Database query failed or account not actually linked

**Solution**:
1. Check browser console for errors
2. Run SQL query to verify account exists in database
3. Check that `getLinkedAccountsForUser()` is being called with correct userId

## Common Use Cases

### Use Case 1: User wants to login faster

**Flow**:
1. User has email/password account
2. Links GitHub account
3. Next time, clicks "Login with GitHub" instead
4. Logs in without typing password

### Use Case 2: User forgot password

**Flow**:
1. User has linked GitHub account
2. User forgot Apiome password
3. User clicks "Login with GitHub"
4. Logs in successfully
5. Can reset password from profile if needed

### Use Case 3: User wants multiple authentication methods

**Flow**:
1. User links GitHub, GitLab, and Google accounts
2. Can login with any of these providers
3. All link to same Apiome account
4. User data is consistent across all logins

### Use Case 4: Wrong account linked

**Flow**:
1. User accidentally linked wrong GitHub account
2. User goes to Dashboard → Linked Accounts
3. Clicks "Unlink" for GitHub
4. Links correct GitHub account

## Next Steps

### Add More Providers

To add GitLab support:

1. **Get GitLab OAuth credentials**:
   - Go to GitLab → Settings → Applications
   - Create new application
   - Add to `.env.local`:
     ```env
     GITLAB_CLIENT_ID=your_gitlab_client_id
     GITLAB_CLIENT_SECRET=your_gitlab_client_secret
     ```

2. **Update NextAuth config** in `[...nextauth]/route.ts`:
   ```typescript
   import GitlabProvider from 'next-auth/providers/gitlab';
   
   // Add to providers array:
   GitlabProvider({
     clientId: process.env.GITLAB_CLIENT_ID as string,
     clientSecret: process.env.GITLAB_CLIENT_SECRET as string,
   }),
   ```

3. **Add GitLab handler** in `credentials.ts`:
   ```typescript
   export const credentialsGitlab = async (payload: any) => {
     // Similar to credentialsGithub
     // Check for linked account, auto-link if needed
   };
   ```

4. **Update signIn callback** in `[...nextauth]/route.ts`:
   ```typescript
   if (loginProvider === 'gitlab') {
     return credentialsGitlab(payload);
   }
   ```

5. **Enable in UI** - Change `available: true` for GitLab in `linked-accounts/page.tsx`

### Implement Token Encryption

**Important for Production!**

```typescript
// Add to helper.ts
const crypto = require('crypto');

function encryptToken(token: string): string {
  const key = process.env.ENCRYPTION_KEY; // 32-byte key
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptToken(encryptedToken: string): string {
  const key = process.env.ENCRYPTION_KEY;
  const parts = encryptedToken.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Use before storing:
const encryptedAccessToken = encryptToken(accessToken);
const encryptedRefreshToken = encryptToken(refreshToken);

// Use when retrieving:
const accessToken = decryptToken(row.access_token);
```

## Success Criteria

✅ Database migration completed without errors
✅ GitHub OAuth credentials configured
✅ Can login with GitHub successfully
✅ GitHub account appears in Linked Accounts list
✅ Can unlink GitHub account
✅ Can re-link GitHub account
✅ Last login timestamp updates
✅ Cannot link same GitHub account to multiple users
✅ Cannot link multiple GitHub accounts to same user

## Support

For issues:
1. Check browser console for JavaScript errors
2. Check terminal/server logs for server errors
3. Run SQL queries to verify database state
4. Review documentation:
   - `LINKED_ACCOUNTS_IMPLEMENTATION.md` - Complete implementation details
   - `LINKED_ACCOUNTS_ARCHITECTURE.md` - System architecture and data flow
   - `EXTERNAL_AUTH_PROVIDERS.md` - Full feature documentation
   - `EXTERNAL_AUTH_PROVIDERS_SUMMARY.md` - Quick reference

## Production Deployment Checklist

Before deploying to production:

- [ ] Implement token encryption
- [ ] Update GitHub OAuth callback URL to production domain
- [ ] Use environment-specific encryption keys
- [ ] Enable HTTPS (required for OAuth)
- [ ] Set up token refresh logic
- [ ] Implement audit logging for link/unlink operations
- [ ] Add email notifications for account linking
- [ ] Set up monitoring for failed OAuth attempts
- [ ] Test all OAuth flows end-to-end
- [ ] Document OAuth setup for team members
- [ ] Back up database before migration
- [ ] Test rollback procedure

