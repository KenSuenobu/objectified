/**
 * The Hive imperative dialogs (HIVE-2.7, #5286).
 *
 * The ticket replaces the browser's native confirm/prompt/alert everywhere in the app. What
 * makes that a *fix* rather than a reskin is the behaviour the native boxes could not have:
 * a named object and a stated consequence, a type-to-confirm gate on the irreversible
 * cases, a labelled and validated field in place of the unlabelled line, and a dialog that
 * refuses to be dismissed while the request it authorised is still running.
 *
 * Each of those is asserted here through the public surface — what a reader sees and what
 * `useDialog()` resolves — rather than through props, so a rewrite of the internals that
 * keeps the behaviour keeps the suite.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import ConfirmDialog from '../src/app/components/dialogs/ConfirmDialog';
import PromptDialog from '../src/app/components/dialogs/PromptDialog';
import AlertDialog from '../src/app/components/dialogs/AlertDialog';
import { DialogProvider, useDialog } from '../src/app/components/providers/DialogProvider';
import { destructiveConfirm } from '../src/app/components/dialogs/destructiveConfirm';
import {
  DIALOG_TONE_BUTTON,
  DIALOG_TONE_INK,
  DIALOG_TONE_TITLE,
  normalizeDialogTone,
} from '../src/app/components/dialogs/dialogTone';

// ---------------------------------------------------------------------------
// The tone vocabulary
// ---------------------------------------------------------------------------

describe('dialogTone', () => {
  it('resolves the pre-Hive spellings onto the tone they always meant', () => {
    expect(normalizeDialogTone('error', 'info')).toBe('danger');
    expect(normalizeDialogTone('warn', 'info')).toBe('warning');
    expect(normalizeDialogTone('ok', 'info')).toBe('success');
  });

  it('passes the Hive spellings through unchanged', () => {
    expect(normalizeDialogTone('danger', 'info')).toBe('danger');
    expect(normalizeDialogTone('success', 'warning')).toBe('success');
  });

  it('falls back when the caller names no tone at all', () => {
    expect(normalizeDialogTone(undefined, 'warning')).toBe('warning');
  });

  it('paints every tone with a token, never a palette literal', () => {
    // The pre-Hive dialogs spelled `text-red-600` and `bg-indigo-600`, which no theme could
    // reach. A frozen colour here would silently un-theme both dialogs.
    for (const ink of Object.values(DIALOG_TONE_INK)) {
      expect(ink).toMatch(/^text-(danger|warn|ok|accent)$/);
    }
  });

  it('gives only the destructive tone a red primary — DESIGN.md §8', () => {
    expect(DIALOG_TONE_BUTTON.danger).toBe('danger');
    expect(DIALOG_TONE_BUTTON.warning).toBe('primary');
    expect(DIALOG_TONE_BUTTON.info).toBe('primary');
    expect(DIALOG_TONE_BUTTON.success).toBe('primary');
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------

describe('ConfirmDialog', () => {
  const baseProps = {
    open: true,
    title: 'Delete role "Editor"?',
    message: 'Members holding this role lose its permissions immediately.',
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };

  beforeEach(() => {
    baseProps.onConfirm.mockClear();
    baseProps.onCancel.mockClear();
  });

  it('is announced as an alert dialog, not an ordinary panel', () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('names the object in its title and states the consequence', () => {
    render(
      <ConfirmDialog
        {...baseProps}
        variant="danger"
        consequence="This is permanent and cannot be undone."
      />
    );
    expect(screen.getByText('Delete role "Editor"?')).toBeInTheDocument();
    expect(
      screen.getByText('Members holding this role lose its permissions immediately.')
    ).toBeInTheDocument();
    expect(screen.getByText('This is permanent and cannot be undone.')).toBeInTheDocument();
  });

  it('reports the confirm and the cancel separately', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog {...baseProps} confirmLabel="Delete role" />);

    await user.click(screen.getByRole('button', { name: 'Delete role' }));
    expect(baseProps.onConfirm).toHaveBeenCalledTimes(1);
    expect(baseProps.onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('is Esc-dismissible', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog {...baseProps} />);
    await user.keyboard('{Escape}');
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a string message’s own line breaks', () => {
    render(<ConfirmDialog {...baseProps} message={'First line\nSecond line'} />);
    expect(screen.getByText(/First line/)).toHaveClass('whitespace-pre-wrap');
  });

  it('renders a node message as given', () => {
    render(<ConfirmDialog {...baseProps} message={<ul><li>A version</li></ul>} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('A version');
  });

  describe('the type-to-confirm gate', () => {
    it('is absent unless a phrase is given', () => {
      render(<ConfirmDialog {...baseProps} confirmLabel="Delete role" />);
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete role' })).toBeEnabled();
    });

    it('holds the primary action disabled until the phrase matches exactly', async () => {
      const user = userEvent.setup();
      render(
        <ConfirmDialog {...baseProps} typeToConfirm="Acme Corp" confirmLabel="Delete tenant" />
      );
      const gate = screen.getByRole('textbox');
      const action = screen.getByRole('button', { name: 'Delete tenant' });

      expect(action).toBeDisabled();

      await user.type(gate, 'Acme');
      expect(action).toBeDisabled();

      await user.type(gate, ' Corp');
      expect(action).toBeEnabled();

      await user.click(action);
      expect(baseProps.onConfirm).toHaveBeenCalledTimes(1);
    });

    it('is case-sensitive — "delete" must not open a tenant called "DELETE"', async () => {
      const user = userEvent.setup();
      render(<ConfirmDialog {...baseProps} typeToConfirm="DELETE" confirmLabel="Delete tenant" />);
      await user.type(screen.getByRole('textbox'), 'delete');
      expect(screen.getByRole('button', { name: 'Delete tenant' })).toBeDisabled();
    });

    it('forgives surrounding whitespace, which a paste brings with it', async () => {
      const user = userEvent.setup();
      render(<ConfirmDialog {...baseProps} typeToConfirm="Acme" confirmLabel="Delete tenant" />);
      await user.type(screen.getByRole('textbox'), '  Acme  ');
      expect(screen.getByRole('button', { name: 'Delete tenant' })).toBeEnabled();
    });

    it('gives the field an accessible name naming the phrase', () => {
      render(<ConfirmDialog {...baseProps} typeToConfirm="Acme Corp" />);
      expect(screen.getByRole('textbox')).toHaveAccessibleName('Type Acme Corp to confirm');
    });

    it('takes focus itself, since it is the thing that has to be typed into', async () => {
      render(<ConfirmDialog {...baseProps} typeToConfirm="Acme Corp" />);
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    });

    it('ignores a click on the disabled action', async () => {
      const user = userEvent.setup();
      render(<ConfirmDialog {...baseProps} typeToConfirm="Acme" confirmLabel="Delete tenant" />);
      await user.click(screen.getByRole('button', { name: 'Delete tenant' }));
      expect(baseProps.onConfirm).not.toHaveBeenCalled();
    });
  });

  describe('while a request is in flight', () => {
    it('disables both buttons', () => {
      render(<ConfirmDialog {...baseProps} busy confirmLabel="Delete role" />);
      expect(screen.getByRole('button', { name: /Delete role/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });

    it('refuses Esc — a half-finished delete must not lose its dialog', async () => {
      const user = userEvent.setup();
      render(<ConfirmDialog {...baseProps} busy />);
      await user.keyboard('{Escape}');
      expect(baseProps.onCancel).not.toHaveBeenCalled();
    });

    it('marks the action busy for assistive technology', () => {
      render(<ConfirmDialog {...baseProps} busy confirmLabel="Delete role" />);
      expect(screen.getByRole('button', { name: /Delete role/ })).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });
  });

  it('shows a failure inside itself rather than closing', () => {
    render(<ConfirmDialog {...baseProps} error="Role is still assigned to 3 members" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Role is still assigned to 3 members');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PromptDialog
// ---------------------------------------------------------------------------

describe('PromptDialog', () => {
  const baseProps = {
    open: true,
    title: 'New role',
    label: 'Role name',
    onSubmit: jest.fn(),
    onCancel: jest.fn(),
  };

  beforeEach(() => {
    baseProps.onSubmit.mockClear();
    baseProps.onCancel.mockClear();
  });

  it('labels its field — the thing the native prompt could never do', () => {
    render(<PromptDialog {...baseProps} helperText="Members see this name." />);
    expect(screen.getByRole('textbox')).toHaveAccessibleName('Role name');
    expect(screen.getByText('Members see this name.')).toBeInTheDocument();
  });

  it('starts from the default value and puts focus in the field', async () => {
    render(<PromptDialog {...baseProps} defaultValue="Editor (copy)" />);
    const field = screen.getByRole('textbox');
    expect(field).toHaveValue('Editor (copy)');
    await waitFor(() => expect(field).toHaveFocus());
  });

  it('hands up the trimmed value', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} confirmLabel="Create role" />);
    await user.type(screen.getByRole('textbox'), '  Release manager  ');
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(baseProps.onSubmit).toHaveBeenCalledWith('Release manager');
  });

  it('submits on Enter, the way the box it replaces did', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} />);
    await user.type(screen.getByRole('textbox'), 'Release manager{Enter}');
    expect(baseProps.onSubmit).toHaveBeenCalledWith('Release manager');
  });

  it('refuses an empty answer and says which field is missing', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} confirmLabel="Create role" />);
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(screen.getByText('Role name is required.')).toBeInTheDocument();
    expect(baseProps.onSubmit).not.toHaveBeenCalled();
  });

  it('refuses whitespace as an answer', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} confirmLabel="Create role" />);
    await user.type(screen.getByRole('textbox'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(baseProps.onSubmit).not.toHaveBeenCalled();
  });

  it('accepts an empty answer when the caller says the field is optional', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} required={false} confirmLabel="Save" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(baseProps.onSubmit).toHaveBeenCalledWith('');
  });

  it('runs the caller’s validation on the trimmed value and shows its complaint', async () => {
    const user = userEvent.setup();
    const validate = jest.fn((value: string) =>
      value === 'Editor' ? 'That is already the name of this collection.' : null
    );
    render(<PromptDialog {...baseProps} validate={validate} confirmLabel="Rename" />);
    await user.type(screen.getByRole('textbox'), '  Editor  ');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(validate).toHaveBeenCalledWith('Editor');
    expect(screen.getByText('That is already the name of this collection.')).toBeInTheDocument();
    expect(baseProps.onSubmit).not.toHaveBeenCalled();
  });

  it('clears its complaint as soon as the reader types again', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} confirmLabel="Create role" />);
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(screen.getByText('Role name is required.')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), 'R');
    expect(screen.queryByText('Role name is required.')).not.toBeInTheDocument();
  });

  it('marks the field invalid, so the red hairline and the announcement agree', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} confirmLabel="Create role" />);
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the caller’s failure under the same field', () => {
    render(<PromptDialog {...baseProps} error="A collection with that name exists" />);
    expect(screen.getByText('A collection with that name exists')).toBeInTheDocument();
  });

  it('renders a textarea when the caller asks for one', () => {
    render(<PromptDialog {...baseProps} multiline label="Release note" />);
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
  });

  it('reports a cancel', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('is Esc-dismissible', async () => {
    const user = userEvent.setup();
    render(<PromptDialog {...baseProps} />);
    await user.keyboard('{Escape}');
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1);
  });

  describe('while a request is in flight', () => {
    it('locks the field and both buttons', () => {
      render(<PromptDialog {...baseProps} busy confirmLabel="Create role" />);
      expect(screen.getByRole('textbox')).toBeDisabled();
      expect(screen.getByRole('button', { name: /Create role/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });

    it('refuses Esc', async () => {
      const user = userEvent.setup();
      render(<PromptDialog {...baseProps} busy />);
      await user.keyboard('{Escape}');
      expect(baseProps.onCancel).not.toHaveBeenCalled();
    });

    it('refuses a second submit', () => {
      render(<PromptDialog {...baseProps} busy defaultValue="Editor" />);
      const form = screen.getByRole('textbox').closest('form');
      act(() => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(baseProps.onSubmit).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// AlertDialog
// ---------------------------------------------------------------------------

describe('AlertDialog', () => {
  it('falls back to the tone’s own noun for a title', () => {
    render(<AlertDialog open message="It broke" variant="error" onClose={jest.fn()} />);
    expect(screen.getByText(DIALOG_TONE_TITLE.danger)).toBeInTheDocument();
  });

  it('prefers the caller’s title', () => {
    render(
      <AlertDialog open title="Could not publish" message="It broke" onClose={jest.fn()} />
    );
    expect(screen.getByText('Could not publish')).toBeInTheDocument();
  });

  it('resolves once on the button and once on Esc, never twice for one dismissal', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const { rerender } = render(<AlertDialog open message="It broke" onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(<AlertDialog open message="It broke" onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts focus on its one action', async () => {
    render(<AlertDialog open message="It broke" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus());
  });
});

// ---------------------------------------------------------------------------
// The imperative API
// ---------------------------------------------------------------------------

/** A harness that calls one member of `useDialog()` and records what it resolved. */
function Harness({ run }: { run: (dialog: ReturnType<typeof useDialog>) => Promise<unknown> }) {
  const dialog = useDialog();
  const [result, setResult] = React.useState<string>('pending');
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          // `JSON.stringify(undefined)` is `undefined`, not a string — `alert()` resolves
          // with nothing, and the harness still has to show that it resolved at all.
          void run(dialog).then((value) => setResult(JSON.stringify(value) ?? 'undefined'));
        }}
      >
        ask
      </button>
      <output role="status">{result}</output>
    </div>
  );
}

/**
 * Render a harness inside the provider and press its trigger.
 *
 * @param run What to call on `useDialog()`.
 * @returns The `userEvent` session, for the interaction under test.
 */
async function ask(run: (dialog: ReturnType<typeof useDialog>) => Promise<unknown>) {
  const user = userEvent.setup();
  render(
    <DialogProvider>
      <Harness run={run} />
    </DialogProvider>
  );
  await user.click(screen.getByRole('button', { name: 'ask' }));
  return user;
}

describe('useDialog', () => {
  it('throws outside a provider rather than silently doing nothing', () => {
    const Bare = () => {
      useDialog();
      return null;
    };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow('useDialog must be used within a DialogProvider');
    spy.mockRestore();
  });

  describe('confirm', () => {
    it('resolves true on the confirm and false on the cancel', async () => {
      const user = await ask((d) => d.confirm({ message: 'Sure?', confirmLabel: 'Yes' }));
      await user.click(await screen.findByRole('button', { name: 'Yes' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('true'));

      await user.click(screen.getByRole('button', { name: 'ask' }));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
    });

    it('closes the dialog once it settles', async () => {
      const user = await ask((d) => d.confirm({ message: 'Sure?', confirmLabel: 'Yes' }));
      await user.click(await screen.findByRole('button', { name: 'Yes' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });

    it('carries the DESIGN.md §8 copy through from destructiveConfirm', async () => {
      await ask((d) =>
        d.confirm(
          destructiveConfirm({
            action: 'Delete',
            noun: 'tenant',
            name: 'Acme Corp',
            consequence: 'Every member loses access.',
            typeToConfirm: true,
          })
        )
      );
      expect(await screen.findByText('Delete tenant "Acme Corp"?')).toBeInTheDocument();
      expect(screen.getByText('Every member loses access.')).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveAccessibleName('Type Acme Corp to confirm');
      expect(screen.getByRole('button', { name: 'Delete tenant' })).toBeDisabled();
    });

    describe('with a perform hook', () => {
      it('holds the dialog open and busy while the work runs, then closes and resolves', async () => {
        let release!: () => void;
        const perform = jest.fn(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            })
        );
        const user = await ask((d) =>
          d.confirm({ message: 'Sure?', confirmLabel: 'Delete', perform })
        );

        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() =>
          expect(screen.getByRole('button', { name: /Delete/ })).toHaveAttribute('aria-busy', 'true')
        );
        // Still open, and Esc will not take it away.
        await user.keyboard('{Escape}');
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();

        await act(async () => {
          release();
        });
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(screen.getByRole('status')).toHaveTextContent('true');
      });

      it('keeps the dialog open and reports the failure inside it', async () => {
        const perform = jest.fn().mockRejectedValue(new Error('Tenant still has projects'));
        const user = await ask((d) =>
          d.confirm({ message: 'Sure?', confirmLabel: 'Delete', perform })
        );

        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        expect(await screen.findByText('Tenant still has projects')).toBeInTheDocument();
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        // The harness sits behind an open modal, which Radix hides from the a11y tree — so
        // this one reads through it. That it is *still* "pending" is the assertion: the
        // caller's promise has not settled, because the confirm has not finished.
        expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('pending');

        // And the reader can still back out, which now resolves false.
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
      });

      it('reports a thrown non-Error as a sentence rather than "[object Object]"', async () => {
        const perform = jest.fn().mockRejectedValue({ code: 500 });
        const user = await ask((d) =>
          d.confirm({ message: 'Sure?', confirmLabel: 'Delete', perform })
        );
        await user.click(await screen.findByRole('button', { name: 'Delete' }));
        expect(
          await screen.findByText('Something went wrong. Please try again.')
        ).toBeInTheDocument();
      });
    });
  });

  describe('prompt', () => {
    it('resolves the trimmed value', async () => {
      const user = await ask((d) => d.prompt({ title: 'New role', label: 'Role name' }));
      await user.type(await screen.findByRole('textbox'), '  Release manager  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('"Release manager"')
      );
    });

    it('resolves null on a cancel — the same contract the native box had', async () => {
      const user = await ask((d) => d.prompt({ title: 'New role', label: 'Role name' }));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('null'));
    });

    it('runs perform with the trimmed value and closes on success', async () => {
      const perform = jest.fn().mockResolvedValue(undefined);
      const user = await ask((d) =>
        d.prompt({ title: 'New role', label: 'Role name', perform })
      );
      await user.type(await screen.findByRole('textbox'), 'Release manager');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(perform).toHaveBeenCalledWith('Release manager'));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('"Release manager"'));
    });

    it('keeps the name in the field when the server refuses it', async () => {
      const perform = jest.fn().mockRejectedValue(new Error('That name is taken'));
      const user = await ask((d) =>
        d.prompt({ title: 'New role', label: 'Role name', perform })
      );
      await user.type(await screen.findByRole('textbox'), 'Editor');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('That name is taken')).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue('Editor');
    });
  });

  describe('focus', () => {
    it('goes back to the control that opened the dialog', async () => {
      // Radix restores focus to a `Dialog.Trigger`, and an awaited `confirm()` has none —
      // left alone it drops a keyboard reader on `<body>`, at the top of the page.
      const user = await ask((d) => d.confirm({ message: 'Sure?', confirmLabel: 'Yes' }));
      // `hidden: true`: an open modal takes the rest of the page out of the accessibility
      // tree, which is itself the behaviour that makes restoring focus matter.
      const trigger = screen.getByRole('button', { name: 'ask', hidden: true });

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(trigger).toHaveFocus());
    });

    it('goes back after a prompt too', async () => {
      const user = await ask((d) => d.prompt({ title: 'New role', label: 'Role name' }));
      const trigger = screen.getByRole('button', { name: 'ask', hidden: true });

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(trigger).toHaveFocus());
    });
  });

  describe('alert', () => {
    it('resolves when it is dismissed', async () => {
      const user = await ask((d) => d.alert({ message: 'Saved', variant: 'success' }));
      await user.click(await screen.findByRole('button', { name: 'OK' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('undefined'));
    });
  });
});
