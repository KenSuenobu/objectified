/**
 * Render tests for the Primitives "Test this type" form.
 *
 * The behaviour that matters here is that validation is *live*: the verdict, the per-field errors
 * and the regex indicator all move on `change` alone, with no button in the card to press. These
 * tests therefore never click a submit/check control — they type, and assert the result.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { PrimitiveTestForm } from '../src/app/ade/dashboard/primitives/PrimitiveTestForm';

const MONEY_SCHEMA = {
  $id: 'https://api.apiome.dev/types/std/v0/types/money',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    amount: { type: 'string', pattern: '^[0-9]+\\.[0-9]{2}$', description: 'A decimal amount.' },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    note: { type: 'string' },
  },
  required: ['amount', 'currency'],
};

const verdict = () => screen.getByTestId('primitive-test-verdict');
const input = (pointer: string) => screen.getByTestId(`primitive-test-input-${pointer}`);

/**
 * Render the card and open it.
 *
 * The card ships collapsed — the form is tall enough to bury the rest of the detail page — and its
 * body is not mounted until the first open, so every test about the form itself starts by expanding
 * it. The collapse behaviour has its own describe block below.
 */
function renderOpen(ui: React.ReactElement) {
  const result = render(ui);
  fireEvent.click(screen.getByTestId('primitive-test-toggle'));
  return result;
}

describe('PrimitiveTestForm — object schemas', () => {
  it('renders the full object: one row per property, with type and required hints', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    // Every declared property gets its own input, not a single JSON blob.
    expect(input('/amount')).toBeInTheDocument();
    expect(input('/currency')).toBeInTheDocument();
    expect(input('/note')).toBeInTheDocument();

    expect(screen.getByText('A decimal amount.')).toBeInTheDocument();
    expect(screen.getAllByText('required')).toHaveLength(2);
  });

  it('has no check/validate button — validation is not something you press', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    const card = screen.getByTestId('primitive-test-form');
    expect(within(card).queryByRole('button', { name: /check|validate|run|submit/i })).not.toBeInTheDocument();
  });

  it('revalidates on every keystroke, with no interaction other than typing', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    // The seeded example does not satisfy the pattern, so the card opens invalid.
    expect(verdict()).toHaveAttribute('data-status', 'invalid');

    fireEvent.change(input('/amount'), { target: { value: '10.00' } });
    fireEvent.change(input('/currency'), { target: { value: 'USD' } });

    expect(verdict()).toHaveAttribute('data-status', 'valid');
    expect(verdict()).toHaveTextContent(/valid against this schema/i);

    // And back again the moment a value stops conforming.
    fireEvent.change(input('/currency'), { target: { value: 'US' } });
    expect(verdict()).toHaveAttribute('data-status', 'invalid');
  });

  it('anchors each violation to its own field', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    fireEvent.change(input('/amount'), { target: { value: '10.00' } });
    fireEvent.change(input('/currency'), { target: { value: 'US' } });

    const currencyErrors = screen.getByTestId('primitive-test-field-findings-/currency');
    expect(currencyErrors).toHaveTextContent(/fewer than 3 characters/i);
    // The conforming field carries no error of its own.
    expect(screen.queryByTestId('primitive-test-field-findings-/amount')).not.toBeInTheDocument();
  });

  it('lets a required property be excluded so the `required` error can be seen live', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    fireEvent.change(input('/amount'), { target: { value: '10.00' } });
    fireEvent.change(input('/currency'), { target: { value: 'USD' } });
    expect(verdict()).toHaveAttribute('data-status', 'valid');

    fireEvent.click(screen.getByTestId('primitive-test-include-/currency'));

    expect(verdict()).toHaveAttribute('data-status', 'invalid');
    expect(screen.getByTestId('primitive-test-findings')).toHaveTextContent(/required property/i);
  });

  it('toggles an optional property in and out of the instance', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    // The generated example covers every property, so `note` opens included and editable.
    expect(input('/note')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('primitive-test-include-/note'));
    expect(screen.queryByTestId('primitive-test-input-/note')).not.toBeInTheDocument();
    expect(screen.getByText('Omitted from the instance.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('primitive-test-include-/note'));
    expect(input('/note')).toBeInTheDocument();
  });

  it('leaves a property the example could not populate switched off', () => {
    // `note` is optional and only a `$ref`, so no example value exists for it.
    renderOpen(
      <PrimitiveTestForm
        schema={{
          type: 'object',
          properties: { id: { type: 'string' }, note: { $ref: './memo' } },
          required: ['id'],
        }}
        name="record"
      />,
    );

    expect(screen.getByText('Omitted from the instance.')).toBeInTheDocument();
    expect(screen.queryByTestId('primitive-test-input-/note')).not.toBeInTheDocument();
  });
});

describe('PrimitiveTestForm — live regular expressions', () => {
  it('applies the pattern as the reader types, with no check step', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    const indicator = () => screen.getByTestId('primitive-test-pattern-/amount');

    // The regex source is shown next to the field it constrains.
    expect(indicator()).toHaveTextContent('^[0-9]+\\.[0-9]{2}$');

    fireEvent.change(input('/amount'), { target: { value: '10.0' } });
    expect(indicator()).toHaveAttribute('data-matches', 'false');
    expect(indicator()).toHaveTextContent(/does not match/i);

    // One more keystroke completes the match — the indicator flips immediately.
    fireEvent.change(input('/amount'), { target: { value: '10.00' } });
    expect(indicator()).toHaveAttribute('data-matches', 'true');
    expect(indicator()).toHaveTextContent(/matches/i);
  });

  it('reports a pattern the browser cannot compile instead of failing silently', () => {
    renderOpen(<PrimitiveTestForm schema={{ type: 'string', pattern: '(unclosed' }} name="broken" />);

    const indicator = screen.getByTestId('primitive-test-pattern-');
    expect(indicator).toHaveAttribute('data-matches', 'invalid-pattern');
  });
});

describe('PrimitiveTestForm — formats', () => {
  const TIMESTAMP_SCHEMA = { type: 'string', format: 'date-time' };

  it('opens blank when the format is all the schema says, with the format as guidance not as the value', () => {
    renderOpen(<PrimitiveTestForm schema={TIMESTAMP_SCHEMA} name="timestamp" />);

    // Never the literal `date-time` in the box — that text fails the format it names.
    expect(input('')).toHaveValue('');
    expect(input('')).toHaveAttribute('placeholder', 'date-time, e.g. 2024-01-15T09:30:00Z');
    // Blank is honestly not a date-time yet, so the card says so rather than pretending otherwise.
    expect(verdict()).toHaveAttribute('data-status', 'invalid');
  });

  it('turns valid the moment a conforming value is typed', () => {
    renderOpen(<PrimitiveTestForm schema={TIMESTAMP_SCHEMA} name="timestamp" />);

    fireEvent.change(input(''), { target: { value: '2024-01-15T09:30:00Z' } });
    expect(verdict()).toHaveAttribute('data-status', 'valid');

    fireEvent.change(input(''), { target: { value: '15/01/2024' } });
    expect(screen.getByTestId('primitive-test-field-findings-')).toHaveTextContent(/must match format/i);
  });

  it('still seeds a formatted field from a value the schema declares for itself', () => {
    renderOpen(
      <PrimitiveTestForm
        schema={{ ...TIMESTAMP_SCHEMA, examples: ['2024-01-15T09:30:00Z'] }}
        name="timestamp"
      />,
    );

    expect(input('')).toHaveValue('2024-01-15T09:30:00Z');
    expect(verdict()).toHaveAttribute('data-status', 'valid');
  });

  it('leaves an optional formatted property switched off instead of opening the card invalid', () => {
    renderOpen(
      <PrimitiveTestForm
        schema={{
          type: 'object',
          properties: { id: { type: 'string' }, occurredAt: TIMESTAMP_SCHEMA },
          required: ['id'],
        }}
        name="event"
      />,
    );

    expect(screen.queryByTestId('primitive-test-input-/occurredAt')).not.toBeInTheDocument();
    expect(verdict()).toHaveAttribute('data-status', 'valid');

    // Switching it on gives an empty input to type into, and the format hint to type by.
    fireEvent.click(screen.getByTestId('primitive-test-include-/occurredAt'));
    expect(input('/occurredAt')).toHaveValue('');
    expect(input('/occurredAt')).toHaveAttribute('placeholder', 'date-time, e.g. 2024-01-15T09:30:00Z');
  });
});

describe('PrimitiveTestForm — single items and arrays', () => {
  const DECIMAL_SCHEMA = { type: 'string', pattern: '^[0-9]+$' };

  it('renders a scalar type as one input', () => {
    renderOpen(<PrimitiveTestForm schema={DECIMAL_SCHEMA} name="decimal" />);

    expect(input('')).toBeInTheDocument();
    fireEvent.change(input(''), { target: { value: '42' } });
    expect(verdict()).toHaveAttribute('data-status', 'valid');
  });

  it('tests the same type as an array, validating each element in place', () => {
    renderOpen(<PrimitiveTestForm schema={DECIMAL_SCHEMA} name="decimal" />);

    fireEvent.click(screen.getByTestId('primitive-test-mode-array'));

    // Array mode opens with a single element.
    fireEvent.change(input('/0'), { target: { value: '42' } });
    expect(verdict()).toHaveAttribute('data-status', 'valid');

    fireEvent.click(screen.getByTestId('primitive-test-array-add-'));
    fireEvent.change(input('/1'), { target: { value: 'not-a-number' } });

    expect(verdict()).toHaveAttribute('data-status', 'invalid');
    expect(screen.getByTestId('primitive-test-field-findings-/1')).toHaveTextContent(/must match pattern/i);

    // Removing the offending element clears the verdict, again with no explicit re-check.
    fireEvent.click(screen.getByTestId('primitive-test-array-remove-/1'));
    expect(verdict()).toHaveAttribute('data-status', 'valid');
  });

  it('tests an object type as an array of objects', () => {
    renderOpen(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    fireEvent.click(screen.getByTestId('primitive-test-mode-array'));

    fireEvent.change(input('/0/amount'), { target: { value: '10.00' } });
    fireEvent.change(input('/0/currency'), { target: { value: 'USD' } });
    expect(verdict()).toHaveAttribute('data-status', 'valid');
  });

  it('renders a natively-array schema as a repeatable list', () => {
    renderOpen(<PrimitiveTestForm schema={{ type: 'array', items: { type: 'integer' } }} name="counts" />);

    fireEvent.change(input('/0'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('primitive-test-array-add-'));
    fireEvent.change(input('/1'), { target: { value: '2' } });

    expect(verdict()).toHaveAttribute('data-status', 'valid');
  });
});

describe('PrimitiveTestForm — degraded inputs', () => {
  it('reports a value that is not readable as the field type, before Ajv is involved', () => {
    renderOpen(<PrimitiveTestForm schema={{ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }} name="n" />);

    fireEvent.change(input('/n'), { target: { value: 'abc' } });

    expect(screen.getByTestId('primitive-test-coercion-/n')).toHaveTextContent(/not a number/i);
    expect(verdict()).toHaveAttribute('data-status', 'invalid');
  });

  it('states which references it could not resolve rather than failing closed', () => {
    renderOpen(
      <PrimitiveTestForm
        schema={{ type: 'object', properties: { amount: { $ref: './decimal' } }, required: ['amount'] }}
        name="money"
      />,
    );

    expect(screen.getByTestId('primitive-test-unresolved-refs')).toHaveTextContent('./decimal');
  });

  it('keeps the form usable when the schema itself will not compile', () => {
    renderOpen(<PrimitiveTestForm schema={{ type: 'string', pattern: '(' }} name="broken" />);

    expect(verdict()).toHaveAttribute('data-status', 'unavailable');
    expect(verdict()).toHaveTextContent(/could not be compiled/i);
    expect(input('')).toBeInTheDocument();
  });
});

describe('PrimitiveTestForm — collapse', () => {
  it('starts collapsed, showing only the heading and what the card is for', () => {
    render(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    expect(screen.getByTestId('primitive-test-form')).toBeInTheDocument();
    expect(screen.getByText('Test this type')).toBeInTheDocument();
    expect(screen.getByText(/validated as you type/i)).toBeInTheDocument();
    expect(screen.getByTestId('primitive-test-toggle')).toHaveAttribute('aria-expanded', 'false');

    // Nothing of the form is built yet — not the fields, not the verdict, not the controls.
    expect(screen.queryByTestId('primitive-test-verdict')).not.toBeInTheDocument();
    expect(screen.queryByTestId('primitive-test-input-/amount')).not.toBeInTheDocument();
    expect(screen.queryByTestId('primitive-test-reset')).not.toBeInTheDocument();
    expect(screen.queryByTestId('primitive-test-mode-single')).not.toBeInTheDocument();
  });

  it('builds and shows the form on the first open', () => {
    render(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);

    fireEvent.click(screen.getByTestId('primitive-test-toggle'));

    expect(screen.getByTestId('primitive-test-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(input('/amount')).toBeVisible();
    expect(verdict()).toBeVisible();
    expect(screen.getByTestId('primitive-test-reset')).toBeVisible();
  });

  it('hides the form again on collapse', () => {
    render(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);
    const toggle = screen.getByTestId('primitive-test-toggle');

    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(input('/amount')).not.toBeVisible();
  });

  it('keeps what was typed across a collapse and re-open', () => {
    // The body stays mounted after the first open, so collapsing is not a reset.
    render(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);
    const toggle = screen.getByTestId('primitive-test-toggle');

    fireEvent.click(toggle);
    fireEvent.change(input('/amount'), { target: { value: '10.00' } });
    fireEvent.change(input('/currency'), { target: { value: 'USD' } });
    expect(verdict()).toHaveAttribute('data-status', 'valid');

    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(input('/amount')).toHaveValue('10.00');
    expect(verdict()).toHaveAttribute('data-status', 'valid');
  });

  it('points the toggle at the region it controls', () => {
    render(<PrimitiveTestForm schema={MONEY_SCHEMA} name="money" />);
    const toggle = screen.getByTestId('primitive-test-toggle');
    fireEvent.click(toggle);

    const controlled = toggle.getAttribute('aria-controls');
    expect(controlled).toBeTruthy();
    expect(document.getElementById(controlled as string)).toContainElement(input('/amount'));
  });
});
