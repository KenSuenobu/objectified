# GitLab OAuth Quick Start Checklist

## What Was Done ✅

Your application now supports GitLab login. The following changes have been made:

### Code Updates
- ✅ NextAuth configuration updated (`src/app/api/auth/[...nextauth]/route.ts`)
- ✅ GitLab OAuth functions added (`lib/auth/credentials.ts`)
- ✅ GitLab button enabled on login page (`src/app/login/LoginClient.tsx`)

### Features Enabled
- ✅ Single Sign-On via GitLab
- ✅ Auto-account linking on first login
- ✅ Manual account linking from dashboard
- ✅ Account management and unlinking
- ✅ Last login tracking

---

## What You Need To Do

### Step 1: Create GitLab OAuth Application
1. Visit https://gitlab.com/-/user_settings/applications
2. Click "Add new application"
3. Fill in:
   - **Name**: `Apiome`
   - **Redirect URI**: `https://yourdomain.com/api/auth/oauth2/callback/gitlab`
   - **Scopes**: Select `api`, `read_user` 
   - **Confidential**: ✓ Check this box
4. Click "Save application"

### Step 2: Save Your Credentials
GitLab will show you:
- **Application ID** → Copy this
- **Client secret** → Copy this securely

### Step 3: Add Environment Variables

Create or update `.env.local` in your project root:

```env
GITLAB_CLIENT_ID=<paste-your-application-id>
GITLAB_CLIENT_SECRET=<paste-your-client-secret>
```

### Step 4: Restart Your Application

```bash
# Stop current process (Ctrl+C)
npm run dev
```

---

## Testing

1. Open login page: `http://localhost:3000/login`
2. Click **"Continue with GitLab"** button
3. You'll be redirected to GitLab
4. Approve the permission request
5. You'll be logged in!

---

## Environment Variables Reference

```env
# Required for GitLab OAuth
GITLAB_CLIENT_ID=your-app-id-here
GITLAB_CLIENT_SECRET=your-secret-here

# Optional - set if not using default domain
NEXTAUTH_URL=https://yourdomain.com
```

---

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "Invalid redirect URI" | Check exact domain in GitLab app matches your URL |
| "Callback URL mismatch" | Restart application after adding env vars |
| Button doesn't appear | Check imports include `SiGitlab` |
| Login fails silently | Check browser console for errors |
| "App not found" | Verify Client ID and Secret are correct |

---

## Files Changed

| File | Changes |
|------|---------|
| `src/app/api/auth/[...nextauth]/route.ts` | Added GitLab provider config and handler |
| `lib/auth/credentials.ts` | Added `credentialsGitlab()` and `linkGitlabAccount()` |
| `src/app/login/LoginClient.tsx` | Enabled GitLab SSO button |

---

## Next Steps (Optional)

- [ ] Configure GitLab for your production domain
- [ ] Test account linking from dashboard
- [ ] Set up GitLab group sync (future feature)
- [ ] Monitor login analytics

---

## Support Documentation

For detailed setup instructions, see: `GITLAB_SSO_SETUP.md`
For technical details, see: `GITLAB_OAUTH_IMPLEMENTATION.md`

---

**Status**: ✅ Implementation Complete
**Version**: Next.js 16.0.7 | NextAuth 4.24.13
**Date**: December 2024

