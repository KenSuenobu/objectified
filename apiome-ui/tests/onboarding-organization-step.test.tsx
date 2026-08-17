/**
 * Organization-step live validation tests (OLO-4.2, #4206).
 *
 * The step derives a slug suggestion from the organization name (editable;
 * suggestions stop once the slug is hand-edited and resume when cleared),
 * shape-validates the slug as the user types, and probes availability against
 * `HEAD /v1/tenants/{slug}` after a debounce. A taken slug blocks Continue;
 * a failed probe warns but fails open.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockCheckSlugAvailability = jest.fn<Promise<{ status: string; error?: string }>, [string]>();
jest.mock('@lib/auth/tenant-slug-availability', () => ({
  checkTenantSlugAvailability: (slug: string) => mockCheckSlugAvailability(slug),
}));

import {
  OrganizationStep,
  SLUG_CHECK_DEBOUNCE_MS,
} from '@/app/components/auth/onboarding/OrganizationStep';

const onBack = jest.fn();
const onContinue = jest.fn();

/** Renders the step empty (the wizard's first visit). */
const renderStep = (initialName = '', initialSlug = '') =>
  render(
    <OrganizationStep
      initialName={initialName}
      initialSlug={initialSlug}
      onBack={onBack}
      onContinue={onContinue}
    />
  );

const nameInput = () => screen.getByPlaceholderText('Acme, Inc.');
const slugInput = () => screen.getByPlaceholderText('acme-inc');

/** Runs the debounce timer and flushes the resolved probe promise. */
const flushProbe = async () => {
  await act(async () => {
    jest.advanceTimersByTime(SLUG_CHECK_DEBOUNCE_MS);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCheckSlugAvailability.mockResolvedValue({ status: 'available' });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('OrganizationStep: slug suggestion', () => {
  it('derives the slug from the name as it is typed', () => {
    renderStep();

    fireEvent.change(nameInput(), { target: { value: 'Acme, Inc.' } });

    expect(slugInput()).toHaveValue('acme-inc');
  });

  it('stops overwriting the slug once it is hand-edited', () => {
    renderStep();

    fireEvent.change(nameInput(), { target: { value: 'Acme' } });
    fireEvent.change(slugInput(), { target: { value: 'my-org' } });
    fireEvent.change(nameInput(), { target: { value: 'Acme Corp' } });

    expect(slugInput()).toHaveValue('my-org');
  });

  it('resumes suggestions after the slug is cleared', () => {
    renderStep();

    fireEvent.change(nameInput(), { target: { value: 'Acme' } });
    fireEvent.change(slugInput(), { target: { value: 'my-org' } });
    fireEvent.change(slugInput(), { target: { value: '' } });
    fireEvent.change(nameInput(), { target: { value: 'Acme Corp' } });

    expect(slugInput()).toHaveValue('acme-corp');
  });

  it('treats a prefilled slug (returning to the step) as hand-edited', () => {
    renderStep('Acme Corp', 'chosen-slug');

    fireEvent.change(nameInput(), { target: { value: 'Acme Corporation' } });

    expect(slugInput()).toHaveValue('chosen-slug');
  });
});

describe('OrganizationStep: live shape validation', () => {
  it('flags a malformed slug as the user types, before any submit', () => {
    renderStep();

    fireEvent.change(slugInput(), { target: { value: 'Not a slug!' } });

    // The message's own opening: the standing hint under the field names the same
    // three characters, and both lines show at once (HIVE-4.4's `SlugField`).
    expect(
      screen.getByText(/must contain only lowercase letters, numbers, and dashes/i)
    ).toBeInTheDocument();
    expect(mockCheckSlugAvailability).not.toHaveBeenCalled();
  });

  it('flags a reserved slug', () => {
    renderStep();

    fireEvent.change(slugInput(), { target: { value: 'me' } });

    expect(screen.getByText(/reserved word/i)).toBeInTheDocument();
    expect(mockCheckSlugAvailability).not.toHaveBeenCalled();
  });
});

describe('OrganizationStep: availability probe', () => {
  it('debounces the probe and reports an available slug', async () => {
    renderStep();

    fireEvent.change(nameInput(), { target: { value: 'Acme Corp' } });

    expect(screen.getByTestId('slug-availability')).toHaveTextContent(/checking availability/i);
    expect(mockCheckSlugAvailability).not.toHaveBeenCalled();

    await flushProbe();

    expect(mockCheckSlugAvailability).toHaveBeenCalledTimes(1);
    expect(mockCheckSlugAvailability).toHaveBeenCalledWith('acme-corp');
    expect(screen.getByTestId('slug-availability')).toHaveTextContent(
      /"acme-corp" is available/i
    );
  });

  it('probes only the final slug of a fast typing burst', async () => {
    renderStep();

    fireEvent.change(slugInput(), { target: { value: 'ac' } });
    jest.advanceTimersByTime(SLUG_CHECK_DEBOUNCE_MS - 1);
    fireEvent.change(slugInput(), { target: { value: 'acme' } });
    jest.advanceTimersByTime(SLUG_CHECK_DEBOUNCE_MS - 1);
    fireEvent.change(slugInput(), { target: { value: 'acme-corp' } });

    await flushProbe();

    expect(mockCheckSlugAvailability).toHaveBeenCalledTimes(1);
    expect(mockCheckSlugAvailability).toHaveBeenCalledWith('acme-corp');
  });

  it('reports a taken slug', async () => {
    mockCheckSlugAvailability.mockResolvedValue({ status: 'taken' });
    renderStep();

    fireEvent.change(slugInput(), { target: { value: 'taken-slug' } });
    await flushProbe();

    expect(screen.getByTestId('slug-availability')).toHaveTextContent(
      /"taken-slug" is already taken/i
    );
  });

  it('warns without blocking when the probe fails', async () => {
    mockCheckSlugAvailability.mockResolvedValue({ status: 'unknown' });
    renderStep();

    fireEvent.change(slugInput(), { target: { value: 'acme-corp' } });
    await flushProbe();

    expect(screen.getByTestId('slug-availability')).toHaveTextContent(
      /could not verify availability/i
    );
  });
});

describe('OrganizationStep: submit gating', () => {
  it('blocks Continue when the live probe already marked the slug taken', async () => {
    mockCheckSlugAvailability.mockResolvedValue({ status: 'taken' });
    renderStep();

    fireEvent.change(nameInput(), { target: { value: 'Acme Corp' } });
    await flushProbe();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    expect(screen.getByText(/already taken — please choose another/i)).toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();
    // The cached probe verdict is reused; no second call on submit.
    expect(mockCheckSlugAvailability).toHaveBeenCalledTimes(1);
  });

  it('runs one final check on submit when no fresh probe result exists', async () => {
    mockCheckSlugAvailability.mockResolvedValue({ status: 'taken' });
    renderStep();

    // Submit while the debounced probe is still pending: the submit-time
    // check must not wait for the debounce timer.
    fireEvent.change(nameInput(), { target: { value: 'Acme Corp' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    expect(mockCheckSlugAvailability).toHaveBeenCalledWith('acme-corp');
    expect(screen.getByText(/already taken — please choose another/i)).toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('continues with an available slug', async () => {
    renderStep();

    fireEvent.change(nameInput(), { target: { value: 'Acme, Inc.' } });
    await flushProbe();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    expect(onContinue).toHaveBeenCalledWith({ name: 'Acme, Inc.', slug: 'acme-inc' });
  });

  it('fails open when availability cannot be verified', async () => {
    mockCheckSlugAvailability.mockResolvedValue({ status: 'unknown' });
    renderStep();

    fireEvent.change(nameInput(), { target: { value: 'Acme Corp' } });
    await flushProbe();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    expect(onContinue).toHaveBeenCalledWith({ name: 'Acme Corp', slug: 'acme-corp' });
  });

  it('re-checks after the taken slug is edited to a free one', async () => {
    mockCheckSlugAvailability.mockResolvedValueOnce({ status: 'taken' });
    renderStep();

    fireEvent.change(slugInput(), { target: { value: 'taken-slug' } });
    await flushProbe();
    expect(screen.getByTestId('slug-availability')).toHaveTextContent(/already taken/i);

    mockCheckSlugAvailability.mockResolvedValue({ status: 'available' });
    fireEvent.change(nameInput(), { target: { value: 'Acme Corp' } });
    fireEvent.change(slugInput(), { target: { value: 'free-slug' } });
    await flushProbe();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    expect(onContinue).toHaveBeenCalledWith({ name: 'Acme Corp', slug: 'free-slug' });
  });
});
