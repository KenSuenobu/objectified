/**
 * The What's New dialog — viewport-centred overlay (#2531), re-tokened onto the Hive
 * `Dialog` primitive by HIVE-3.4 (#5290).
 *
 * Two things are worth holding still here. The first is the bug #2531 fixed: the sheet is
 * fixed to the *viewport*, not to whatever scrolled or transformed container happened to
 * render it, which is why it is portalled out of the tree that opens it. The second is the
 * behaviour the ticket asks for: the notes are fetched from `/WHATS_NEW.md` when the
 * dialog opens and not before, and a fetch that fails says so rather than showing an empty
 * sheet.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('rehype-raw', () => ({
  __esModule: true,
  default: () => () => {},
}));

import WhatsNewDialog from '../src/app/components/ade/WhatsNewDialog';
import { APP_VERSION_BADGE } from '../lib/app-version';

describe('WhatsNewDialog', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValue({
      // No leading heading: the `react-markdown` mock folds a `# …` document into one
      // `<h1>`, which would make the assertion below about the mock rather than the fetch.
      text: () => Promise.resolve('Shiny new things.'),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('portals the sheet out of the opening tree, so it centres on the viewport', async () => {
    // A transformed ancestor is the exact condition that broke #2531: `position: fixed`
    // resolves against a transformed element rather than against the viewport.
    render(
      <div style={{ transform: 'translateX(10px)' }}>
        <WhatsNewDialog isOpen onClose={jest.fn()} />
      </div>
    );

    const sheet = await screen.findByTestId('whats-new-dialog');

    expect(sheet).toHaveClass('fixed');
    // Radix portals into `document.body`; the wrapper it creates is untransformed, so the
    // sheet still measures against the viewport. What matters is that neither the sheet
    // nor anything above it is the transformed div this test rendered it inside.
    let ancestor: HTMLElement | null = sheet.parentElement;
    while (ancestor && ancestor !== document.body) {
      expect(ancestor.style.transform).toBe('');
      ancestor = ancestor.parentElement;
    }
    expect(ancestor).toBe(document.body);
  });

  it('renders nothing, and fetches nothing, while closed', () => {
    render(<WhatsNewDialog isOpen={false} onClose={jest.fn()} />);

    expect(screen.queryByTestId('whats-new-dialog')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches the notes on open and stamps them with the running build', async () => {
    render(<WhatsNewDialog isOpen onClose={jest.fn()} />);

    expect(global.fetch).toHaveBeenCalledWith('/WHATS_NEW.md');
    expect(await screen.findByText('Shiny new things.')).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-dialog')).toHaveTextContent(APP_VERSION_BADGE);
  });

  it('says so when the notes cannot be loaded', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));

    render(<WhatsNewDialog isOpen onClose={jest.fn()} />);

    expect(await screen.findByText(/couldn't load the release notes/i)).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('closes on Esc and on the close button, which a hand-rolled portal never did', async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<WhatsNewDialog isOpen onClose={onClose} />);

    await screen.findByTestId('whats-new-dialog');

    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });
});
