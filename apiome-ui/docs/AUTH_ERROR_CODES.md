# Structured Auth Error Contract (OLO-1.5, #4190)

Login failures are never free text: every rejection carries a **stable machine-readable code**
delivered to the login page as the NextAuth error redirect param:

```
/login?error=<code>
```

The login page maps each code to distinct user guidance. The codes below are a **public
contract** consumed by the login UX (OLO-3.2) and any future surface that needs to explain an
auth failure.

## Stability rules

- **Never change or reuse an existing code value.** Add a new code instead, and document it here.
- A code's *meaning* is fixed forever; its user-facing copy may be reworded.
- The same values are defined in both engines and must stay identical:
  - TypeScript: `AUTH_ERROR_CODES` in `apiome-ui/lib/auth/account-resolution.ts`
  - Python: module constants + `AUTH_ERROR_CODES` in `apiome-rest/src/app/account_resolution.py`
- User copy lives in `apiome-ui/src/app/login/auth-error-copy.ts` (`AUTH_ERROR_COPY`); every
  contract code must have an entry there.
- Redirects are built through `loginErrorRedirect()` in `account-resolution.ts` so the transport
  shape can never drift.

## Stable codes

| Code | Meaning | Emitted by |
|------|---------|-----------|
| `unverified-email` | The provider could not prove the sign-in email is verified; auto-link and signup are refused (nOAuth hardening, OLO-1.3(d)/1.4). | Resolution engine (both sides) |
| `identity-linked-elsewhere` | This `(provider, provider_user_id)` identity is already bound to a **different** user. | `linkExternalAccount` (`lib/db/helper.ts`), resolution engine auto-link fallback |
| `account-disabled` | The resolved user account is disabled (`users.enabled = false`), or the identity points at a deleted user. | Resolution engine, credentials sign-in |
| `membership-suspended` | The user's tenant membership is suspended (`tenant_users.status = 'suspended'`). | Resolution engine gate, via `ResolutionUser.membershipSuspended` / `membership_suspended` — populated by tenant-scoped sign-in surfaces (invitation acceptance, tenant selection; OLO-3.x/5.x). The plain login flow has no tenant context and does not set it. |
| `provider-not-configured` | The requested sign-in provider is not configured/supported on this deployment. | `signInForProvider` dispatch (`lib/auth/credentials.ts`) |
| `signup-disabled` | Self-signup is disabled on this deployment (`AUTH_SIGNUP_DISABLED=true|1`); a verified email with no existing account is refused instead of routed to onboarding. | Resolution engine step (c) |
| `account-not-verified` | The resolved account exists but has not completed its own email verification (`users.verified = false`). | Resolution engine, credentials sign-in |
| `provider-already-linked` | The user already has a different identity linked for this provider (link flow). | `linkExternalAccount` (`lib/db/helper.ts`) |
| `last-sign-in-method` | Unlink refused: the identity is the user's last remaining sign-in method — no other linked identity and no usable password (`users.password` empty) — so removing it would lock them out (OLO-2.4). | `unlinkExternalAccount` (`lib/db/helper.ts`) |
| `sign-in-failed` | Generic sign-in failure with no user-actionable detail; the `signIn` callback's defensive fallback when a provider yields no resolvable user. Kept generic so the redirect leaks no account existence signal (OLO-7.3). Renders the generic banner. | NextAuth `signIn` callback (`src/app/api/auth/[...nextauth]/route.ts`) |

## Pre-contract stable copy keys

These predate the kebab-case convention and keep their original values under the stability rule:

| Code | Meaning | Emitted by |
|------|---------|-----------|
| `OAuthEmailRequired` | The provider shared no email address at all. | Resolution engine |
| `OAuthProfileIncomplete` | The OAuth response carried no stable provider user id. | Resolution engine |

## Other codes the login page understands

Not part of the resolution contract, but they arrive on the same query param:

| Code | Source |
|------|--------|
| `AccessDenied`, `CredentialsSignin` | NextAuth built-ins |
| `TwoFactorInvalid` | TOTP second-step failure (OLO-9.13 #5014) |
| `OAuthAccountExists` | Signup flow (`lib/auth/oauth-signup-actions.ts`) |
| `SignupSessionExpired` | OAuth signup completion page (`src/app/signup/oauth/page.tsx`) |

Unknown codes fall back to a **safe generic banner** (`GENERIC_AUTH_ERROR` in
`auth-error-copy.ts`) — the page never breaks on a new code, and because the `?error=` value is
attacker-influenced it is **never echoed back into the page**. Every intentional emission should
still be mapped and documented.

## Rendering affordances (OLO-3.2, #4200)

Each copy entry may set `retry: true`, which renders a **"Try again"** link in the login banner
pointing back to a clean `/login` (error cleared, validated `callbackUrl` preserved). It is set
on codes the user can resolve outside Apiome and then retry (`unverified-email`,
`account-not-verified`, `OAuthEmailRequired`, `OAuthProfileIncomplete`, `SignupSessionExpired`,
and the generic fallback). Terminal states — `account-disabled`, `membership-suspended`,
`signup-disabled`, `provider-not-configured`, link conflicts — deliberately offer none;
`CredentialsSignin` instead re-expands the credentials form (OLO-3.1).

## Configuration

| Variable | Effect |
|----------|--------|
| `AUTH_SIGNUP_DISABLED` | `true` or `1` refuses self-signup with `signup-disabled`. Any other value (or unset) leaves signup open. Read by `isSignupDisabled()` at each OAuth sign-in. |

## Tests forcing each code

- `apiome-ui/tests/auth-error-contract.test.ts` — value stability, an emission test per code, and
  copy coverage/distinctness.
- `apiome-ui/tests/login-error-rendering.test.tsx` — OLO-3.2 rendering: a banner snapshot per
  code, safe-generic fallback for unknown codes, and retry-affordance coverage.
- `apiome-ui/tests/account-resolution.test.ts`, `apiome-rest/tests/test_account_resolution.py` —
  the OLO-1.3 policy matrix.
- `apiome-rest/tests/test_auth_error_contract.py` — Python parity: values, set membership, and an
  emission test per engine-emitted code.
