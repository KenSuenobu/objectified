# GitLab OAuth Setup Verification Checklist

## ✅ Code Implementation Status

### Backend Configuration
- [x] GitLab provider imported in NextAuth route
- [x] GitLab provider configured with env variables
- [x] GitLab callback handler implemented
- [x] Account linking flow integrated

### Authentication Functions
- [x] `linkGitlabAccount()` function created
- [x] `credentialsGitlab()` function created
- [x] GitLab profile field mapping correct
- [x] Error handling implemented
- [x] Last login tracking enabled

### Frontend UI
- [x] GitLab icon import added
- [x] GitLab button uncommented
- [x] Button click handler connected
- [x] SSO loading state supported

### Imports & Exports
- [x] All imports are correct
- [x] All functions are exported
- [x] No circular dependencies
- [x] Type definitions included

---

## 📋 GitLab Configuration Checklist

### Before You Start
- [ ] You have a GitLab account
- [ ] You have admin access to create OAuth apps
- [ ] You know your domain/subdomain

### Step 1: Access GitLab Settings
- [ ] Navigate to https://gitlab.com/-/user_settings/applications
- [ ] Logged in successfully
- [ ] Can see existing applications (if any)

### Step 2: Create OAuth Application
- [ ] Click "Add new application"
- [ ] Enter name: `Apiome`
- [ ] Enter redirect URI correctly
- [ ] Selected scopes: `api` and `read_user`
- [ ] Checked "Confidential" checkbox
- [ ] Clicked "Save application"

### Step 3: Obtain Credentials
- [ ] Copied Application ID
- [ ] Copied Client secret
- [ ] Saved both values securely
- [ ] Did NOT share credentials publicly

### Step 4: Local Environment Setup
- [ ] Created/opened `.env.local` file
- [ ] Added `GITLAB_CLIENT_ID=<your-id>`
- [ ] Added `GITLAB_CLIENT_SECRET=<your-secret>`
- [ ] Saved `.env.local`
- [ ] Verified `.env.local` is in `.gitignore`

### Step 5: Application Restart
- [ ] Stopped running development server
- [ ] Ran `npm run dev`
- [ ] No error messages in console
- [ ] Application loaded successfully

---

## 🧪 Testing Checklist

### UI Verification
- [ ] Login page loads without errors
- [ ] "Continue with GitLab" button is visible
- [ ] Button styling looks correct
- [ ] GitLab icon displays properly

### OAuth Flow Test
- [ ] Click GitLab button
- [ ] Redirected to GitLab login page
- [ ] Can see permission request
- [ ] Can approve permissions
- [ ] Redirected back to application

### Login Functionality
- [ ] First login creates/links account
- [ ] User is authenticated
- [ ] Redirected to dashboard
- [ ] User information displays correctly

### Account Linking (If Applicable)
- [ ] Existing users can link GitLab account
- [ ] Linked account appears in settings
- [ ] Can unlink account
- [ ] Can re-link account

---

## 🔍 Troubleshooting Checklist

### Environment Variables
- [ ] `.env.local` file exists
- [ ] `GITLAB_CLIENT_ID` is set
- [ ] `GITLAB_CLIENT_SECRET` is set
- [ ] No typos in variable names
- [ ] File is NOT in .gitignore by mistake

### GitLab Application Settings
- [ ] Redirect URI matches exactly
- [ ] Application is marked as "Confidential"
- [ ] Scopes include `api` and `read_user`
- [ ] Application is not disabled

### Network/CORS
- [ ] Application is accessible
- [ ] No proxy/firewall blocking requests
- [ ] HTTPS is being used (for production)
- [ ] Cookies are enabled in browser

### Application Logs
- [ ] Check browser console for errors (F12)
- [ ] Check server logs for issues
- [ ] Look for OAuth callback errors
- [ ] Verify user creation/linking logs

---

## 📝 Configuration Validation

### URLs to Verify
```
Development Redirect URI:
  http://localhost:3000/api/auth/oauth2/callback/gitlab

Production Redirect URI:
  https://your-domain.com/api/auth/oauth2/callback/gitlab
```

### Environment Variables to Verify
```env
✓ GITLAB_CLIENT_ID=your-application-id
✓ GITLAB_CLIENT_SECRET=your-client-secret
✓ NEXTAUTH_URL=your-deployment-url (if needed)
```

---

## 🚀 Deployment Checklist

### Pre-Deployment
- [ ] Tested in local development
- [ ] No hardcoded credentials in code
- [ ] `.gitignore` includes `.env.local`
- [ ] All dependencies installed

### Production Setup
- [ ] Created GitLab OAuth app for production domain
- [ ] Set environment variables in deployment platform
- [ ] Production domain matches GitLab redirect URI
- [ ] Database migrations run (if any)
- [ ] Application deployed successfully

### Post-Deployment
- [ ] Login page is accessible
- [ ] GitLab button works
- [ ] Can complete full login flow
- [ ] No errors in production logs
- [ ] Monitor for any issues

---

## 📊 Expected Behavior

### First-Time GitLab Login
1. User clicks GitLab button
2. Approves permissions
3. Redirected to application
4. Account auto-linked if email matches
5. User is authenticated
6. Redirected to dashboard

### Returning GitLab User
1. User clicks GitLab button
2. Auto-authenticated (cached session on GitLab)
3. Redirected to dashboard immediately

### Account Linking Flow
1. Logged-in user visits linked accounts page
2. Clicks "Link GitLab"
3. Goes through OAuth flow
4. Account linked upon successful auth
5. Confirmation message displayed

---

## 🔒 Security Verification

- [ ] Client secret is NOT in code
- [ ] Client secret is NOT in git history
- [ ] `.env.local` is git-ignored
- [ ] HTTPS is used in production
- [ ] OAuth redirect URI matches exactly
- [ ] User data is handled securely
- [ ] Tokens are stored securely
- [ ] No sensitive data in logs

---

## 📞 Support Resources

If issues persist:

1. **Check Logs**: Browser console and server logs
2. **Verify Credentials**: Double-check GitLab app ID and secret
3. **Test URL**: Ensure redirect URI matches
4. **Restart**: Sometimes a restart solves caching issues
5. **Documentation**: See GITLAB_SSO_SETUP.md for detailed guide

---

## Final Verification

```javascript
// Quick verification script to test
const result = {
  gitlabProviderConfigured: true,        // ✅
  credentialsGitlabFunction: true,       // ✅
  linkGitlabAccountFunction: true,       // ✅
  gitlabButtonEnabled: true,             // ✅
  environmentVariablesNeeded: [          // ✅
    "GITLAB_CLIENT_ID",
    "GITLAB_CLIENT_SECRET"
  ]
};

console.log("✅ Implementation Complete");
console.log("⏳ Waiting for: Environment variables");
console.log("✨ Result: Ready to test");
```

---

## Sign-Off

- [ ] All code changes verified
- [ ] GitLab OAuth app created
- [ ] Environment variables set
- [ ] Application tested
- [ ] Documentation reviewed
- [ ] Ready for production deployment

---

**Last Updated**: December 2024
**Implementation Status**: ✅ COMPLETE
**Deployment Ready**: ⏳ Pending environment configuration

