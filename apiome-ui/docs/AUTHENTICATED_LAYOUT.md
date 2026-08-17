# AuthenticatedLayout Component

> **Note (HIVE-3.8, #5294).** The examples below used to render `TopHeader` inside the
> layout. That chrome is retired: `/ade/**` routes draw the Hive `AppShell` rail, and the
> `/ade` launcher draws its own. `AuthenticatedLayout` itself is unchanged — it wraps
> whatever chrome the route owns.

A reusable wrapper component that automatically handles user authentication and session management for protected pages.

## Features

- **Automatic Session Checking**: Validates user authentication before rendering children
- **Auto-redirect**: Redirects unauthenticated users to login page
- **Loading State**: Shows loading indicator while checking authentication
- **Reusable**: Can be used in any layout or page that requires authentication
- **Configurable**: Allows custom redirect URLs

## Usage

### In a Layout File

Wrap your protected content with both `SessionWrapper` (for NextAuth session provider) and `AuthenticatedLayout`:

```tsx
import SessionWrapper from "@/app/components/auth/SessionWrapper";
import AuthenticatedLayout from "@/app/components/auth/AuthenticatedLayout";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionWrapper>
          <AuthenticatedLayout>{children}</AuthenticatedLayout>
        </SessionWrapper>
      </body>
    </html>
  );
}
```

### Custom Redirect URL

By default, unauthenticated users are redirected to `/login`. You can customize this:

```tsx
<AuthenticatedLayout redirectTo="/custom-login">
  {children}
</AuthenticatedLayout>
```

### In Individual Pages

You can also use it to protect individual pages:

```tsx
import AuthenticatedLayout from "@/app/components/auth/AuthenticatedLayout";

export default function ProtectedPage() {
  return (
    <AuthenticatedLayout>
      <div>This content is protected</div>
    </AuthenticatedLayout>
  );
}
```

## How It Works

1. **Session Check**: Uses `useSession()` from NextAuth to check authentication status
2. **Loading State**: While checking (`status === 'loading'`), displays a loading indicator
3. **Redirect**: If no session exists (`session === null`), redirects to login page
4. **Render**: If authenticated, renders all children components
5. **Auto-availability**: Any child component can access the session via `useSession()` hook

## Benefits

- **No Duplication**: Write session checking logic once, reuse everywhere
- **Consistent UX**: All protected pages have the same authentication flow
- **Cleaner Components**: Child components don't need authentication logic
- **Type Safe**: Full TypeScript support
- **Performance**: Only checks authentication once per page load

## Example: a child component

With `AuthenticatedLayout`, a child that needs the session is simplified:

```tsx
const ProfileBadge = () => {
  const { data: session } = useSession(); // Session is guaranteed to exist
  
  // No need for:
  // - useRouter for redirects
  // - useEffect for session checking
  // - status checking
  // - null checks before rendering
  
  return (
    <header>
      <Avatar src={session?.user?.image} />
      {/* Rest of component */}
    </header>
  );
}
```

## Architecture

```
SessionWrapper (NextAuth Provider)
  └── AuthenticatedLayout (Auth Guard)
        ├── AppShell rail (uses session)
        └── Page Content (Uses session)
```

This creates a clean separation of concerns where:
- `SessionWrapper`: Provides NextAuth session context
- `AuthenticatedLayout`: Guards routes and ensures authentication
- Child components: Simply consume the session without worrying about authentication state

