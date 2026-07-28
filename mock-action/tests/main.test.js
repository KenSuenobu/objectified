'use strict';
/**
 * Smoke tests for the action entrypoints (#4748, PMR-3.1).
 *
 * `node --check` only parses a file: it cannot catch a helper that is used but never imported.
 * These tests actually execute `main.js` and `post.js` in a child process, so the module graph and
 * the paths that run before Docker is ever contacted are exercised for real.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const ACTION_DIR = path.resolve(__dirname, '..');

/**
 * Run one of the action scripts and capture its outcome.
 *
 * @param {string} script File name inside the action directory.
 * @param {Record<string, string>} env Environment overrides.
 * @returns {{status: number, output: string}} Exit status and combined output.
 */
function runScript(script, env) {
  try {
    const output = execFileSync(process.execPath, [path.join(ACTION_DIR, script)], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

test('main.js fails cleanly when no bundle is given', () => {
  const result = runScript('main.js', { GITHUB_WORKSPACE: ACTION_DIR });

  assert.equal(result.status, 1);
  assert.match(result.output, /Input "bundle" is required/);
});

test('main.js refuses a bundle outside the workspace before touching Docker', () => {
  const result = runScript('main.js', {
    GITHUB_WORKSPACE: ACTION_DIR,
    INPUT_BUNDLE: '../../etc/passwd',
  });

  assert.equal(result.status, 1);
  assert.match(result.output, /outside the workspace/);
});

test('main.js reports a bundle path that does not exist', () => {
  const result = runScript('main.js', {
    GITHUB_WORKSPACE: ACTION_DIR,
    INPUT_BUNDLE: 'no-such-bundle.json',
  });

  assert.equal(result.status, 1);
  assert.match(result.output, /Bundle not found at /);
});

test('main.js validates its numeric inputs', () => {
  const result = runScript('main.js', {
    GITHUB_WORKSPACE: ACTION_DIR,
    INPUT_BUNDLE: 'package.json',
    INPUT_PORT: 'eighty',
  });

  assert.equal(result.status, 1);
  assert.match(result.output, /Input "port" \(eighty\) must be a non-negative integer/);
});

test('post.js is a no-op when no container was started', () => {
  const result = runScript('post.js', {});

  assert.equal(result.status, 0);
  assert.equal(result.output.trim(), '');
});
