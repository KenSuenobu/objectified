# GitLab SSO Setup Guide for Apiome

This guide explains how to set up GitLab OAuth SSO (Single Sign-On) for the Apiome application using NextAuth.js.

## Overview

GitLab login has been enabled in your application. Users can now authenticate using their GitLab account. The implementation includes:

- **Auto-linking**: First-time login with GitLab automatically links the account
- **Account management**: Users can manage linked GitLab accounts in their dashboard
- **Security**: OAuth2 flow with secure token handling

## GitLab OAuth Application Setup

Follow these steps to create and configure a GitLab OAuth application:

### Step 1: Access GitLab Applications
1. Go to **GitLab.com** and log in to your GitLab account
2. Navigate to **Settings → Applications** (or go directly to: https://gitlab.com/-/user_settings/applications)
3. Click **Add new application** button

### Step 2: Create OAuth Application

Fill in the application details:

**Application name:**
```
Apiome
```

**Redirect URI:**
```
https://your-domain.com/api/auth/oauth2/callback/gitlab
```
*Replace `your-domain.com` with your actual domain*

**Scopes:** Select the following scopes
- ✓ `api` - Full API access
- ✓ `read_user` - Read user information
- ✓ `read_repository` - Read repository data (optional, if needed)

**Confidential:** 
- ✓ Check "Confidential" for enhanced security

### Step 3: Save Credentials

After creating the application, GitLab will display:
- **Application ID** (also called Client ID)
- **Client secret**

**IMPORTANT:** Save these values securely. You'll need them in the next step.

### Step 4: Configure Environment Variables

Add the following environment variables to your `.env.local` file:

```env
GITLAB_CLIENT_ID=your-application-id-here
GITLAB_CLIENT_SECRET=your-client-secret-here
```

Example (not real credentials):
```env
GITLAB_CLIENT_ID=1234567890abcdef1234567890abcdef
GITLAB_CLIENT_SECRET=glsoat-xxxxxxxxxxxxxxxxxxxx
```

### Step 5: Restart Your Application

Restart the Next.js application for the environment variables to take effect:

```bash
npm run dev        # for development
# or
npm run build && npm start  # for production
```

## Testing the GitLab Login

1. Navigate to your login page
2. Click the **"Continue with GitLab"** button
3. You'll be redirected to GitLab's authorization screen
4. Approve the application's request for permissions
5. You'll be automatically logged in to Apiome

### First-Time Login
- If your GitLab email matches an existing Apiome user, you'll be logged in as that user
- The GitLab account is automatically linked to your Apiome account
- Future logins via GitLab will use this link

### Linked Accounts
- Users can view and manage linked GitLab accounts in their dashboard
- Navigate to **Settings → Linked Accounts** to see all connected providers

## Implementation Details

### Code Changes Made

1. **NextAuth Configuration** (`src/app/api/auth/[...nextauth]/route.ts`):
   - Added `GitlabProvider` from next-auth
   - Configured with environment variables for Client ID and Secret
   - Added GitLab OAuth callback handler

2. **Authentication Logic** (`lib/auth/credentials.ts`):
   - Added `credentialsGitlab()` function for OAuth flow
   - Added `linkGitlabAccount()` function for account linking
   - Supports both first-time login and linked account scenarios

3. **UI Components** (`src/app/login/LoginClient.tsx`):
   - Added GitLab SSO button with icon
   - Integrated with existing OAuth flow

### OAuth Flow

```
User clicks "Continue with GitLab"
    ↓
Redirected to GitLab authorization page
    ↓
User approves permissions
    ↓
GitLab redirects to /api/auth/oauth2/callback/gitlab with auth code
    ↓
NextAuth exchanges code for access token
    ↓
credentialsGitlab() checks if account is linked
    ↓
If linked: Login as linked user
If not linked: Check email, auto-link on successful login
    ↓
User is authenticated
```

## Troubleshooting

### "Invalid redirect URI" error
- **Cause:** The Redirect URI in GitLab doesn't match your application URL
- **Fix:** Ensure your domain is correct and matches exactly (including https/http)

### "Application not found" error
- **Cause:** Invalid Application ID or Client Secret
- **Fix:** Double-check the credentials in `.env.local`

### "Callback URL mismatch"
- **Cause:** Environment variables not loaded after restart
- **Fix:** Restart the application: `npm run dev` or `npm start`

### User email not matching
- **Cause:** GitLab email differs from Apiome account email
- **Fix:** User must create an account with the same email first, or manually link accounts

### Account already linked to another user
- **Cause:** Attempting to link an account that's already linked
- **Fix:** Unlink the account from the other user first

## Advanced Configuration

### Custom Redirect URL
If you're running on a different port or subdomain:

```env
NEXTAUTH_URL=https://your-domain.com/
GITLAB_CLIENT_ID=your-app-id
GITLAB_CLIENT_SECRET=your-secret
```

### Local Development
For localhost development:

```env
NEXTAUTH_URL=http://localhost:3000
GITLAB_CLIENT_ID=your-app-id
GITLAB_CLIENT_SECRET=your-secret
```

## Security Considerations

1. **Never commit secrets:** Keep `.env.local` in `.gitignore`
2. **Rotate secrets:** Regenerate GitLab secret if compromised
3. **Use HTTPS:** Always use HTTPS in production (http://localhost OK for dev)
4. **Scope limitation:** Only request necessary scopes in GitLab app settings
5. **Token expiration:** NextAuth handles token refresh automatically

## Additional Resources

- [NextAuth.js GitLab Provider Docs](https://next-auth.js.org/providers/gitlab)
- [GitLab OAuth Documentation](https://docs.gitlab.com/ee/api/oauth2.html)
- [GitLab Applications](https://gitlab.com/-/user_settings/applications)

## Support

If you encounter issues:

1. Check browser console for errors
2. Review application logs
3. Verify environment variables are set correctly
4. Ensure GitLab account email is registered in Apiome
5. Check that the GitLab application's redirect URI matches exactly

---

**Last Updated:** December 2024
**Next.js Version:** 16.0.7
**NextAuth Version:** 4.24.13

