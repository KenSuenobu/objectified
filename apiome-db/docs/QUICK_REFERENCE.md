# 🎯 Linked Accounts Feature - Quick Reference Card

## 📍 Access Points

| What | Where | URL |
|------|-------|-----|
| **Feature Page** | Dashboard → Linked Accounts | http://localhost:3000/ade/dashboard/linked-accounts |
| **Login Page** | Main Login | http://localhost:3000/login |
| **GitHub OAuth** | OAuth Callback | http://localhost:3000/api/auth/oauth2/callback/github |

## 🗂️ Database

**Table:** `apiome.external_auth_providers`
```sql
-- Quick check
SELECT * FROM apiome.external_auth_providers;

-- View with user info
SELECT eap.*, u.name, u.email 
FROM apiome.external_auth_providers eap
JOIN apiome.users u ON eap.user_id = u.id;
```

## 💻 Code Locations

| Component | File Path |
|-----------|-----------|
| **UI Page** | `apiome-ui/src/app/ade/dashboard/linked-accounts/page.tsx` |
| **Navigation** | `apiome-ui/src/app/components/ade/dashboard/DashboardSideNav.tsx` |
| **DB Functions** | `apiome-ui/lib/db/helper.ts` |
| **OAuth Logic** | `apiome-ui/lib/auth/credentials.ts` |
| **Migration** | `apiome-db/scripts/20251121-external-auth-providers.sql` |

## 🔧 Helper Functions

```typescript
// Get all linked accounts for a user
getLinkedAccountsForUser(userId: string)

// Link a new OAuth provider
linkExternalAccount(userId, provider, providerUserId, ...)

// Remove a linked account
unlinkExternalAccount(userId: string, linkedAccountId: string)

// Check if provider account exists
getLinkedAccountByProvider(provider: string, providerUserId: string)

// Update last login time
updateLinkedAccountLastLogin(provider: string, providerUserId: string)
```

## 🧪 Test Commands

```bash
# Full system check
./apiome-db/scripts/test-linked-accounts.sh

# Database verification
psql -U kenji -d kenji -f apiome-db/scripts/test-external-auth-providers.sql

# Check server status
lsof -i :3000

# Quick database query
psql -U kenji -d kenji -c "SELECT COUNT(*) FROM apiome.external_auth_providers;"
```

## 📚 Documentation Index

| Document | Purpose | Read Time |
|----------|---------|-----------|
| **LINKED_ACCOUNTS_QUICKSTART.md** | Get started fast | 5 min |
| **LINKED_ACCOUNTS_IMPLEMENTATION.md** | Implementation details | 15 min |
| **LINKED_ACCOUNTS_ARCHITECTURE.md** | System design | 10 min |
| **LINKED_ACCOUNTS_TESTING_CHECKLIST.md** | Test all features | 30 min |
| **EXTERNAL_AUTH_PROVIDERS.md** | Complete reference | 30 min |
| **IMPLEMENTATION_COMPLETE.md** | Status summary | 5 min |

## 🔑 OAuth Providers

| Provider | Status | Config Required |
|----------|--------|-----------------|
| **GitHub** | ✅ Active | ✓ Configured |
| GitLab | 🔜 Coming Soon | ✗ Not configured |
| Google/GCP | 🔜 Coming Soon | ✗ Not configured |
| AWS | 🔜 Coming Soon | ✗ Not configured |

## ⚡ Quick Start

### 1. Verify Setup
```bash
./apiome-db/scripts/test-linked-accounts.sh
```

### 2. Test Login
1. Go to: http://localhost:3000/login
2. Click "Sign in with GitHub"
3. Authorize app
4. Should auto-login

### 3. View Linked Accounts
1. Dashboard → Linked Accounts
2. See your GitHub account listed

### 4. Test Unlinking
1. Click "Unlink" button
2. Confirm dialog
3. Account removed

## 🚨 Common Issues

| Issue | Solution |
|-------|----------|
| "User not found" | User must exist with matching email first |
| "Already linked" | Provider account already linked to another user |
| Page not found | Make sure Next.js server is running |
| Database error | Run migration script |
| OAuth fails | Check GITHUB_ID and GITHUB_SECRET in .env |

## 📊 Status Dashboard

```
✅ Database: OPERATIONAL
✅ Backend: IMPLEMENTED
✅ Frontend: DEPLOYED
✅ OAuth: CONFIGURED (GitHub)
✅ Documentation: COMPLETE
✅ Tests: PASSING
```

## 🔗 Quick Links

- **Main Page:** http://localhost:3000/ade/dashboard/linked-accounts
- **Login:** http://localhost:3000/login
- **Dashboard:** http://localhost:3000/ade/dashboard
- **Docs Folder:** `apiome-db/docs/`

## 🎯 Key Features

- ✓ Link multiple OAuth providers to one account
- ✓ Auto-link on first OAuth login
- ✓ Manual link/unlink from dashboard
- ✓ Server-side only (no public REST endpoints)
- ✓ Secure with unique constraints
- ✓ User ID always from apiome.users

## ⚠️ Production TODO

- [ ] Implement token encryption (CRITICAL)
- [ ] Add token refresh logic
- [ ] Enable HTTPS
- [ ] Add rate limiting
- [ ] Implement audit logging
- [ ] Set up monitoring

---

**Last Updated:** November 21, 2025  
**Status:** ✅ OPERATIONAL  
**Version:** 1.0.0

