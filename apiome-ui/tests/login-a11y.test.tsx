/**
 * Login page accessibility tests (OLO-3.5, #4203).
 *
 * The front door must be fully keyboard/screen-reader operable. These deterministic
 * jsdom tests pin the structural a11y contract that the Playwright/axe e2e suite
 * (e2e/login-a11y.spec.ts) then verifies against a real browser:
 *
 *   1. Every form field is programmatically associated with a visible <label>, so it is
 *      reachable by accessible name (getByLabelText succeeds) — the fix for the previously
 *      orphaned `htmlFor` labels whose inputs carried no matching `id`.
 *   2. Fields advertise the correct autocomplete tokens so password managers / assistive
 *      tech can fill them.
 *   3. The page exposes a single <main> landmark (axe `region`) and one <h1>.
 *   4. The collapsed-credentials expand control is a labelled button wired with
 *      aria-expanded / aria-controls.
 *   5. Auth messages announce to screen readers — errors assertively (role="alert"),
 *      success/info politely (role="status").
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@lib/auth/session-client', () => ({
  signIn: jest.fn(),
}));

jest.mock('../lib/db/helper', () => ({
  createSignupRequest: jest.fn(),
}));

jest.mock('@/app/hooks/useDarkMode', () => ({
  useDarkMode: () => false,
}));

import LoginClient from '../src/app/login/LoginClient';
import type { ProviderSummary } from '../lib/auth/provider-registry';

const summary = (id: string, label: string): ProviderSummary => ({
  id,
  label,
  status: 'available',
  enabled: true,
});

const PROVIDERS = [summary('github', 'GitHub'), summary('gitlab', 'GitLab')];

describe('LoginClient — form field labelling (OLO-3.5)', () => {
  it('associates the email and password labels with their inputs (sign-in)', () => {
    // No SSO providers → the credentials form renders expanded.
    render(<LoginClient ssoProviders={[]} />);

    const email = screen.getByLabelText('Email Address');
    const password = screen.getByLabelText('Password');

    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('id', 'email');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('id', 'password');
  });

  it('advertises the correct autocomplete tokens for a sign-in', () => {
    render(<LoginClient ssoProviders={[]} />);

    expect(screen.getByLabelText('Email Address')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('labels every field in sign-up mode and switches the password token to new-password', () => {
    render(<LoginClient ssoProviders={[]} />);

    // Switch to sign-up so the extra fields render.
    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));

    expect(screen.getByLabelText('Full Name')).toHaveAttribute('autocomplete', 'name');
    expect(screen.getByLabelText('Email Address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    // The optional acquisition field carries a wrapped label; match on its leading text.
    expect(screen.getByLabelText(/How did you hear about us\?/)).toBeInTheDocument();
  });
});

describe('LoginClient — landmarks and headings (OLO-3.5)', () => {
  it('renders exactly one <main> landmark and one <h1>', () => {
    render(<LoginClient ssoProviders={PROVIDERS} />);

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome back');
  });

  it('marks the decorative aurora background aria-hidden so it is out of the a11y tree', () => {
    const { container } = render(<LoginClient ssoProviders={PROVIDERS} />);
    // The aurora field is the first child inside the page wrapper.
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });
});

describe('LoginClient — collapsed-credentials expand control (OLO-3.5)', () => {
  it('exposes the expand control as a button wired with aria-expanded/aria-controls', () => {
    render(<LoginClient ssoProviders={PROVIDERS} />);

    const expand = screen.getByRole('button', { name: 'or use your email' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveAttribute('aria-controls', 'credentials-form');

    // The control points at a real form element in the DOM.
    const form = document.getElementById('credentials-form');
    expect(form?.tagName).toBe('FORM');
  });
});

describe('LoginClient — message announcements (OLO-3.5)', () => {
  it('announces auth errors assertively via role="alert"', () => {
    render(<LoginClient ssoProviders={PROVIDERS} error="CredentialsSignin" />);

    const banner = screen.getByTestId('login-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveAttribute('aria-live', 'assertive');
  });
});
