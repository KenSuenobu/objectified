# GitLab OAuth Architecture & Flow Diagrams

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Apiome Application                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Frontend (React/Next.js)                                   │
│  ┌──────────────────────────────────┐                       │
│  │  Login Page                      │                       │
│  │  ┌────────────────────────────┐  │                       │
│  │  │ GitLab Login Button       │  │                       │
│  │  └────────────────────────────┘  │                       │
│  └──────────────────────────────────┘                       │
│              │                                              │
│              ▼                                              │
│  Backend (Node.js/NextAuth)                                │
│  ┌──────────────────────────────────┐                       │
│  │  /api/auth/[...nextauth]/route  │                       │
│  │  ┌────────────────────────────┐  │                       │
│  │  │ GitlabProvider             │  │                       │
│  │  │ ├─ Client ID               │  │                       │
│  │  │ └─ Client Secret           │  │                       │
│  │  └────────────────────────────┘  │                       │
│  │  ┌────────────────────────────┐  │                       │
│  │  │ signIn Callback            │  │                       │
│  │  │ ├─ credentialsGitlab()     │  │                       │
│  │  │ └─ linkGitlabAccount()     │  │                       │
│  │  └────────────────────────────┘  │                       │
│  └──────────────────────────────────┘                       │
│              │                                              │
│              ▼                                              │
│  Database (PostgreSQL)                                     │
│  ┌──────────────────────────────────┐                       │
│  │ external_auth_providers          │                       │
│  │ ├─ user_id                       │                       │
│  │ ├─ provider ('gitlab')           │                       │
│  │ ├─ provider_user_id              │                       │
│  │ ├─ email                         │                       │
│  │ ├─ username                      │                       │
│  │ ├─ avatar_url                    │                       │
│  │ ├─ profile_url                   │                       │
│  │ └─ last_login                    │                       │
│  └──────────────────────────────────┘                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────┐
        │      GitLab OAuth Service      │
        │ (https://gitlab.com/oauth)     │
        │                                │
        │ ├─ Authorization Endpoint      │
        │ └─ Token Endpoint              │
        └────────────────────────────────┘
```

---

## OAuth2 Authentication Flow

### First-Time User (Auto-Linking)

```
User                Application              GitLab
  │                      │                      │
  │ Click GitLab Login   │                      │
  ├─────────────────────►│                      │
  │                      │ Redirect to OAuth    │
  │                      ├─────────────────────►│
  │                      │                      │
  │   User sees GitLab   │                      │
  │◄──────────────────────────────────────────┤
  │                      │                      │
  │ Approve Permissions  │                      │
  ├─────────────────────────────────────────►│
  │                      │                      │
  │                      │ Exchange Code        │
  │                      │ for Access Token     │
  │                      ◄─────────────────────┤
  │                      │                      │
  │ Callback URL         │                      │
  │◄─────────────────────┤ Get User Profile    │
  │                      ◄─────────────────────┤
  │                      │                      │
  │   [credentialsGitlab]                      │
  │   Check linked account ✗                   │
  │   Check email match ✓                      │
  │   Auto-link account                        │
  │   Create JWT token                         │
  │                      │                      │
  │ Logged In! ✓         │                      │
  │◄─────────────────────┤                      │
```

### Returning User (Linked)

```
User                Application              GitLab
  │                      │                      │
  │ Click GitLab Login   │                      │
  ├─────────────────────►│                      │
  │                      │ OAuth Flow           │
  │                      ├─────────────────────►│
  │                      │ (GitLab remembers)   │
  │                      │                      │
  │ Quick Redirect       │ Token Exchange       │
  │◄───────────────────────────────────────────┤
  │                      │                      │
  │   [credentialsGitlab]                      │
  │   Check linked ✓ Found!                    │
  │   Get user from DB                         │
  │   Update last login                        │
  │   Create JWT token                         │
  │                      │                      │
  │ Logged In! ✓         │                      │
  │◄─────────────────────┤                      │
```

---

## Account Linking Flow

### Manual Account Linking

```
Logged-in User      Application             GitLab
        │                 │                    │
        │ Visit Settings  │                    │
        ├────────────────►│                    │
        │ Click Link      │                    │
        │ GitLab          │                    │
        ├────────────────►│                    │
        │                 │ Set linking        │
        │                 │ intent cookie      │
        │                 │ [10 min expiry]    │
        │                 │                    │
        │ Redirect to     │                    │
        │ GitLab OAuth    │                    │
        │◄────────────────┤                    │
        │                 │ OAuth Flow         │
        │                 ├───────────────────►│
        │                 │ (User approves)    │
        │                 │ (GitLab redirects) │
        │                 │◄───────────────────┤
        │                 │                    │
        │   [signIn Callback]                  │
        │   Check linking intent ✓ Found      │
        │   Provider matches 'gitlab' ✓        │
        │   Call linkGitlabAccount()           │
        │   Save account link                  │
        │   Create JWT token                   │
        │                 │                    │
        │ Linked! ✓       │                    │
        │ Redirect to     │                    │
        │ Dashboard       │                    │
        │◄────────────────┤                    │
```

---

## Data Flow: GitHub to Database

### User Profile Mapping

```
GitLab API Response
    ↓
┌──────────────────────┐
│ {                    │
│   "id": 12345,       │
│   "name": "John Doe",│
│   "login": "johndoe",│
│   "email": "j@ex.com"│
│   "image_url": "...",│
│   "web_url": "..."   │
│ }                    │
└──────────────────────┘
    ↓
credentialsGitlab() Function
    ↓
Check if Linked Account Exists
    ├─ YES: Use stored user_id
    └─ NO: Check email match
        ├─ Match: Auto-link
        └─ No match: Fail
    ↓
linkGitlabAccount() Function
    ↓
Store in Database
    ↓
┌────────────────────────────────────┐
│ external_auth_providers Table      │
├────────────────────────────────────┤
│ user_id             | 42           │
│ provider            | 'gitlab'     │
│ provider_user_id    | 12345        │
│ email               | j@ex.com     │
│ username            | johndoe      │
│ avatar_url          | ...          │
│ profile_url         | ...          │
│ metadata            | {...}        │
│ created_at          | now()        │
│ last_login          | now()        │
└────────────────────────────────────┘
```

---

## Configuration Flow

```
Start
  │
  ▼
Create GitLab OAuth App
  ├─ Set Application Name
  ├─ Set Redirect URI
  ├─ Select Scopes
  └─ Mark Confidential
  │
  ▼
Get Credentials
  ├─ Application ID (Client ID)
  └─ Client Secret
  │
  ▼
Add to .env.local
  ├─ GITLAB_CLIENT_ID=<value>
  └─ GITLAB_CLIENT_SECRET=<value>
  │
  ▼
Restart Application
  ├─ Stop npm run dev
  ├─ Environment reloaded
  └─ GitLab provider initialized
  │
  ▼
Ready to Use ✓
```

---

## Error Handling Flow

```
Login Attempt
    │
    ▼
OAuth Request to GitLab
    │
    ├─ Invalid Credentials
    │   └─ "Invalid Client ID or Secret"
    │
    ├─ Invalid Redirect URI
    │   └─ "Callback URL Mismatch"
    │
    ├─ OAuth Denied
    │   └─ "Access Denied"
    │
    ├─ User Not Found
    │   └─ "Account Not Found"
    │
    └─ User Account Disabled
        └─ "Your Account is Disabled"
        
All errors redirect to:
    /login?error=<message>
```

---

## Security Flow

```
┌─────────────────────────────────────┐
│    Secure OAuth2 Token Exchange     │
├─────────────────────────────────────┤
│                                     │
│  1. Authorization Code              │
│     ├─ Issued by GitLab             │
│     ├─ Single use only              │
│     ├─ Short lived (10 min)         │
│     └─ Only valid for specific URI  │
│                                     │
│  2. Code Exchange                   │
│     ├─ Backend-to-backend          │
│     ├─ Client ID + Secret sent     │
│     └─ Performed server-side        │
│                                     │
│  3. Access Token                    │
│     ├─ Issued by GitLab             │
│     ├─ Never exposed to frontend    │
│     ├─ Stored securely              │
│     └─ Used for API calls           │
│                                     │
│  4. JWT Token                       │
│     ├─ Created by NextAuth          │
│     ├─ Contains user info           │
│     ├─ Signed securely              │
│     └─ Stored in HttpOnly cookie    │
│                                     │
└─────────────────────────────────────┘
```

---

## Component Interaction

```
┌─────────────────┐
│  LoginClient    │
│  (UI Component) │
└────────┬────────┘
         │
    handleSSOLogin('gitlab')
         │
         ▼
┌──────────────────────┐
│  next-auth/react     │
│  signIn() function   │
└────────┬─────────────┘
         │
    OAuth Flow
         │
         ▼
┌──────────────────────────────┐
│  [...nextauth]/route.ts      │
│  NextAuth Configuration      │
└────────┬─────────────────────┘
         │
    Provider: GitlabProvider
    Callback: signIn
         │
         ▼
┌──────────────────────────────┐
│  credentials.ts              │
│  credentialsGitlab()         │
│  linkGitlabAccount()         │
└────────┬─────────────────────┘
         │
    Check/Create account
    Link GitLab account
         │
         ▼
┌──────────────────────────────┐
│  Database                    │
│  external_auth_providers     │
│  users table                 │
└──────────────────────────────┘
```

---

## Deployment Architecture

### Development
```
localhost:3000
    ├─ .env.local
    │   ├─ GITLAB_CLIENT_ID
    │   └─ GITLAB_CLIENT_SECRET
    ├─ GitLab OAuth App (Development)
    │   └─ Redirect URI: http://localhost:3000/api/auth/oauth2/callback/gitlab
    └─ npm run dev
```

### Production
```
your-domain.com
    ├─ Environment Variables (Deployment Platform)
    │   ├─ GITLAB_CLIENT_ID
    │   ├─ GITLAB_CLIENT_SECRET
    │   └─ NEXTAUTH_URL
    ├─ GitLab OAuth App (Production)
    │   └─ Redirect URI: https://your-domain.com/api/auth/oauth2/callback/gitlab
    └─ Deployed Application
```

---

## Feature Matrix

```
┌──────────────────────────────────────────────────────────┐
│                    GITLAB OAUTH FEATURES                │
├──────────────────────────────────────────────────────────┤
│                                                          │
│ Single Sign-On              [████████████] ✓ Complete  │
│ Auto Account Linking        [████████████] ✓ Complete  │
│ Manual Account Linking      [████████████] ✓ Complete  │
│ Account Unlinking           [████████████] ✓ Complete  │
│ Last Login Tracking         [████████████] ✓ Complete  │
│ Error Handling              [████████████] ✓ Complete  │
│ Security/Token Mgmt         [████████████] ✓ Complete  │
│ Email Matching              [████████████] ✓ Complete  │
│ Account Status Validation   [████████████] ✓ Complete  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

**All diagrams show the complete GitLab OAuth implementation flow**

