/**
 * The native-dialog sweep (HIVE-2.7, #5286).
 *
 * The acceptance criterion of the ticket is a `grep` over `apiome-ui/src` that comes back
 * empty. `eslint-rules/hive.js` catches the next one as it is typed; this is the other half,
 * so the claim is a property of the repository rather than of whoever last ran `yarn lint` —
 * and it runs in the ordinary `yarn test` gate, which is where a regression is noticed.
 *
 * It also pins the replacement: every screen that had a native dialog now reaches the same
 * `useDialog()`, and the three cases #5286 singles out for a type-to-confirm gate still have
 * one. A sweep that only proves an absence is a sweep that can be satisfied by deleting the
 * feature.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/** Repository root of `apiome-ui`. */
const APP_ROOT = join(__dirname, '..');

/** The tree the criterion covers — the whole app. */
const SWEPT_DIR = 'src';

/**
 * A dialog reached through a global object — `window.confirm(`, `globalThis.alert(`.
 *
 * This is the acceptance criterion's own `grep`, generalised past `window`. Nothing in the
 * app may match it.
 */
const GLOBAL_DIALOG = /\b(?:window|globalThis|self|top|parent)\.(?:confirm|prompt|alert)\s*\(/g;

/**
 * A bare `confirm(` / `prompt(` / `alert(`.
 *
 * This one is ambiguous by construction: it matches the browser's global *and* the
 * `const { confirm } = useDialog()` member that replaced it, because a regular expression
 * cannot resolve a name through scope — `eslint-rules/hive.js` is the half that can. What
 * the sweep can still assert is the property that separates them: a file calling a bare
 * `confirm(` must be a file that got the name from `useDialog()`. A `confirm(` in a module
 * with no hook in it is the browser's, and there are none.
 *
 * `(?<![\w.$])` keeps `confirmDialog(` and `dialogs.confirm(` out — a longer identifier and
 * a member call are both somebody else's function.
 */
const BARE_DIALOG = /(?<![\w.$])(?:confirm|prompt|alert)\s*\(/g;

/** Every `.ts`/`.tsx` file under `dir`, as repository-relative paths. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (['.ts', '.tsx'].includes(extname(child))) found.push(relative(APP_ROOT, child));
    }
  };
  walk(join(APP_ROOT, dir));
  return found;
}

/** Every swept source file, collected once. */
const SWEPT_FILES = sourceFiles(SWEPT_DIR);

/**
 * The lines of `path` that are neither blank nor a comment.
 *
 * The sweep is about *calls*, and the modules that replaced the native dialogs necessarily
 * talk about them in prose. A crude line-level filter is enough here — a `//` or `*` at the
 * start of a trimmed line — because no call site in this tree hides a dialog behind one.
 *
 * @param path A repository-relative path.
 * @returns `[lineNumber, text]` pairs of the code lines.
 */
function codeLines(path: string): [number, string][] {
  return readFileSync(join(APP_ROOT, path), 'utf8')
    .split('\n')
    .map((text, index): [number, string] => [index + 1, text])
    .filter(([, text]) => {
      const trimmed = text.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

/**
 * Every match of `pattern` in the swept tree's code, as `path:line  match` strings.
 *
 * Reported as strings rather than counted so a failure names the file and line outright.
 *
 * @param pattern A global regular expression.
 * @returns One entry per match.
 */
function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const path of SWEPT_FILES) {
    for (const [line, text] of codeLines(path)) {
      for (const match of text.matchAll(pattern)) {
        hits.push(`${path}:${line}  ${match[0].trim()}`);
      }
    }
  }
  return hits;
}

describe('the native-dialog sweep', () => {
  it('covers the whole app, so the sweep cannot pass by looking somewhere small', () => {
    expect(SWEPT_FILES.length).toBeGreaterThan(200);
  });

  it('finds no dialog reached through window, globalThis or self', () => {
    expect(offenders(GLOBAL_DIALOG)).toEqual([]);
  });

  it('leaves every bare confirm/prompt/alert in a file that took it from useDialog()', () => {
    const unbound = SWEPT_FILES.filter((path) => {
      const source = readFileSync(join(APP_ROOT, path), 'utf8');
      const calls = codeLines(path).flatMap(([line, text]) =>
        [...text.matchAll(BARE_DIALOG)].map((match) => `${path}:${line}  ${match[0].trim()}`)
      );
      return calls.length > 0 && !source.includes('useDialog()');
    });
    expect(unbound).toEqual([]);
  });

  it('still catches one when it comes back', () => {
    // The patterns are the load-bearing part of the two assertions above, so they are
    // exercised on text that is known to offend — a sweep whose regex had quietly stopped
    // matching would otherwise report a clean tree forever.
    const globals = [
      'if (!window.confirm("Delete?")) return;',
      'const name = window.prompt("Name");',
      'globalThis.alert("Saved");',
    ].join('\n');
    expect([...globals.matchAll(GLOBAL_DIALOG)]).toHaveLength(3);

    const bare = ['if (!confirm(`Delete tenant "${t.name}"?`)) return;', 'alert("Saved");'].join(
      '\n'
    );
    expect([...bare.matchAll(BARE_DIALOG)]).toHaveLength(2);
  });

  it('does not mistake a longer identifier or a member call for a native dialog', () => {
    const sample = [
      'await confirmDialog({ message: "x" });',
      'await alertDialog({ message: "x" });',
      'await dialogs.confirm({});',
      'const promptText = buildPrompt();',
    ].join('\n');
    expect([...sample.matchAll(BARE_DIALOG)]).toEqual([]);
    expect([...sample.matchAll(GLOBAL_DIALOG)]).toEqual([]);
  });
});

describe('the replacement each screen now reaches', () => {
  /** The screens #5286 lists as having carried a native dialog, that still ask through the hook. */
  const MIGRATED = [
    'src/app/components/ade/dashboard/mcp/McpCollectionsPanel.tsx',
    'src/app/admin/dashboard/users/UserManagementClient.tsx',
    'src/app/admin/dashboard/tenants/TenantManagementClient.tsx',
    'src/app/admin/dashboard/licenses/LicenseManagementClient.tsx',
    'src/app/admin/dashboard/templates/PropertyTemplateManagementClient.tsx',
  ];

  it.each(MIGRATED)('%s uses useDialog()', (path) => {
    expect(readFileSync(join(APP_ROOT, path), 'utf8')).toContain('useDialog()');
  });

  /**
   * Screens that have since gone one better than the shared confirm.
   *
   * `useDialog()` is a generic question with a sentence for an answer, and a redesign
   * sometimes needs the *shape* the mockup draws — an `alertdialog` whose administrator
   * variant carries a danger banner that counts what removing them would leave, or a
   * suspend confirm that says the seat is kept. Those cannot be a string, so the screen
   * owns the dialog instead of borrowing one.
   *
   * Listed with the component that replaced the hook, so backing the dialog out without
   * putting *something* real in its place fails here rather than passing quietly. The
   * absence of a native dialog is still swept above, for these files as for every other.
   */
  const OWN_DIALOGS = [
    ['src/app/ade/dashboard/members/MembersClient.tsx', 'OffboardMemberDialog'],
    ['src/app/ade/dashboard/members/MembersClient.tsx', 'SuspendMemberDialog'],
    // HIVE-5.3 (#5306). The roles screen left the shared hook for the same reason: a
    // `prompt` holds one text field, and New role needs a second control ("Copy permissions
    // from"); a `confirm` holds a sentence, and Delete names the people whose access
    // changes. The fourth, `UnsavedChangesDialog`, has three ways out rather than two — the
    // shared confirm cannot offer "save and continue" as well as "discard".
    ['src/app/ade/dashboard/roles/RolesClient.tsx', 'NewRoleDialog'],
    ['src/app/ade/dashboard/roles/RolesClient.tsx', 'DuplicateRoleDialog'],
    ['src/app/ade/dashboard/roles/RolesClient.tsx', 'DeleteRoleDialog'],
    ['src/app/ade/dashboard/roles/RolesClient.tsx', 'UnsavedChangesDialog'],
    // HIVE-5.4 (#5307). The API keys screen left the shared confirm because a sentence
    // cannot show the twelve-character prefix that identifies the key in monospace, and
    // because a `confirm` has nowhere to report a refused write — the old handlers logged to
    // the console and left the row unchanged. The third, `ApiKeySecretDialog`, is not a
    // confirm at all: it is the one-time reveal, and it refuses Escape and the scrim so the
    // plaintext key cannot be dropped by a mis-click.
    ['src/app/ade/dashboard/api-keys/ApiKeysClient.tsx', 'DisableApiKeyDialog'],
    ['src/app/ade/dashboard/api-keys/ApiKeysClient.tsx', 'DeleteApiKeyDialog'],
    ['src/app/ade/dashboard/api-keys/ApiKeysClient.tsx', 'ApiKeySecretDialog'],
  ] as const;

  it.each(OWN_DIALOGS)('%s answers through <%s> rather than the shared confirm', (path, component) => {
    const source = readFileSync(join(APP_ROOT, path), 'utf8');
    expect(source).toContain(`<${component}`);
    expect(source).not.toContain('useDialog()');
  });

  /** The three irreversible actions the ticket gates behind type-to-confirm. */
  const GATED = [
    ['src/app/ade/dashboard/projects/page.tsx', 'handlePermanentDelete'],
    ['src/app/admin/dashboard/tenants/TenantManagementClient.tsx', 'handleDeleteTenant'],
    ['src/app/admin/dashboard/users/UserManagementClient.tsx', 'handleDeleteUser'],
  ] as const;

  it.each(GATED)('%s gates %s on typing the object name', (path, handler) => {
    const source = readFileSync(join(APP_ROOT, path), 'utf8');
    const body = source.slice(source.indexOf(`const ${handler} =`));
    expect(body.slice(0, body.indexOf('};'))).toContain('typeToConfirm: true');
  });

  it('no longer asks anyone to type DELETE "mentally"', () => {
    // The pre-Hive permanent-project delete shipped two identical confirms, the second of
    // which asked the reader to imagine typing the word. That is the thing a real gate
    // replaces, so its return would mean the gate had been backed out.
    const source = readFileSync(join(APP_ROOT, 'src/app/ade/dashboard/projects/page.tsx'), 'utf8');
    expect(source).not.toContain('mentally');
    expect(source).not.toContain('doubleConfirmed');
  });
});
