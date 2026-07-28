'use strict';
/** Unit tests for the Apiome mock CI action helpers (#4748, PMR-3.1). */

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const {
  CONTAINER_BUNDLE_PATH,
  CONTAINER_PORT,
  SECRET_ENV,
  conformanceArgs,
  containerName,
  dockerRunArgs,
  outputLine,
  parseBool,
  parseReady,
  resolveBundlePath,
  resolveHost,
  resolvePort,
  resolveWait,
  serviceUrl,
  summaryMarkdown,
} = require('../lib');

const WORKSPACE = path.resolve('/workspace');

test('parseBool accepts the documented true spellings only', () => {
  for (const value of ['true', 'TRUE', ' 1 ', 'yes', 'on']) {
    assert.equal(parseBool(value), true, value);
  }
  for (const value of ['false', '0', 'no', '', undefined, 'maybe', 'truthy']) {
    assert.equal(parseBool(value), false, String(value));
  }
});

test('resolveBundlePath resolves workspace-relative and absolute paths inside the workspace', () => {
  assert.equal(resolveBundlePath('mock-bundle.json', WORKSPACE), path.join(WORKSPACE, 'mock-bundle.json'));
  assert.equal(resolveBundlePath('./dist/b.json', WORKSPACE), path.join(WORKSPACE, 'dist', 'b.json'));
  assert.equal(resolveBundlePath(path.join(WORKSPACE, 'b.json'), WORKSPACE), path.join(WORKSPACE, 'b.json'));
});

test('resolveBundlePath refuses paths that escape the workspace', () => {
  for (const value of ['../secrets.json', '../../etc/passwd', '/etc/passwd']) {
    assert.throws(() => resolveBundlePath(value, WORKSPACE), /outside the workspace/, value);
  }
});

test('resolveBundlePath requires a value', () => {
  assert.throws(() => resolveBundlePath('', WORKSPACE), /is required/);
  assert.throws(() => resolveBundlePath('   ', WORKSPACE), /is required/);
});

test('resolveBundlePath does not treat a sibling prefix as inside the workspace', () => {
  assert.throws(() => resolveBundlePath('/workspace-evil/b.json', WORKSPACE), /outside the workspace/);
});

test('resolveHost defaults to loopback and rejects malformed hosts', () => {
  assert.equal(resolveHost(''), '127.0.0.1');
  assert.equal(resolveHost(undefined), '127.0.0.1');
  assert.equal(resolveHost(' 0.0.0.0 '), '0.0.0.0');
  assert.throws(() => resolveHost('127.0.0.1 --privileged'), /not a valid host/);
});

test('resolvePort accepts 0 for auto-selection and rejects out-of-range values', () => {
  assert.equal(resolvePort(''), 0);
  assert.equal(resolvePort('8080'), 8080);
  assert.throws(() => resolvePort('-1'), /non-negative integer/);
  assert.throws(() => resolvePort('80 80'), /non-negative integer/);
  assert.throws(() => resolvePort('70000'), /between 0 and 65535/);
});

test('resolveWait requires a positive number of seconds', () => {
  assert.equal(resolveWait(''), 60);
  assert.equal(resolveWait('12.5'), 12.5);
  assert.throws(() => resolveWait('0'), /positive number/);
  assert.throws(() => resolveWait('soon'), /positive number/);
});

test('containerName is scoped to the run and sanitized', () => {
  assert.equal(containerName({ GITHUB_RUN_ID: '42' }, 'abcd'), 'apiome-mock-42-abcd');
  assert.equal(containerName({}, 'abcd'), 'apiome-mock-local-abcd');
  assert.equal(containerName({ GITHUB_RUN_ID: 'a/b;rm -rf' }, 'abcd'), 'apiome-mock-abrm-rf-abcd');
});

test('dockerRunArgs publishes the requested interface and mounts the bundle read-only', () => {
  const args = dockerRunArgs({
    name: 'mock-1',
    image: 'ghcr.io/apiome/apiome-mock:0.5.0',
    bundlePath: '/workspace/b.json',
    host: '127.0.0.1',
    port: 34567,
  });
  assert.deepEqual(args, [
    'run',
    '--detach',
    '--name',
    'mock-1',
    '--publish',
    `127.0.0.1:34567:${CONTAINER_PORT}`,
    '--volume',
    `/workspace/b.json:${CONTAINER_BUNDLE_PATH}:ro`,
    'ghcr.io/apiome/apiome-mock:0.5.0',
    'run',
  ]);
});

test('dockerRunArgs forwards the signing secret by name, never by value', () => {
  const args = dockerRunArgs({
    name: 'mock-1',
    image: 'img',
    bundlePath: '/workspace/b.json',
    host: '127.0.0.1',
    port: 1,
    hasSecret: true,
    requireSignature: true,
  });
  const envIndex = args.indexOf(SECRET_ENV);
  assert.ok(envIndex > 0, 'secret env var is passed');
  assert.equal(args[envIndex - 1], '--env');
  assert.ok(args.includes('APIOME_MOCK_REQUIRE_SIGNATURE=true'));
  // The value itself must never appear anywhere in the argument list.
  assert.ok(!args.some((arg) => arg.includes('=') && arg.startsWith(`${SECRET_ENV}=`)));
});

test('conformanceArgs runs the packaged corpus on the container loopback', () => {
  assert.deepEqual(conformanceArgs('mock-1'), [
    'exec',
    'mock-1',
    'apiome-mock',
    'conformance',
    '--base-url',
    `http://127.0.0.1:${CONTAINER_PORT}`,
  ]);
});

test('parseReady extracts the identity a job should record', () => {
  const identity = parseReady({
    status: 'ready',
    runtime: { name: 'apiome-mock', version: '0.5.0', mount: '/acme/petstore/1.0.0' },
    bundle: { digest: 'sha256:abc', tenant: 'acme', project: 'petstore', version: '1.0.0', signed: true },
  });
  assert.deepEqual(identity, {
    digest: 'sha256:abc',
    runtimeVersion: '0.5.0',
    mount: '/acme/petstore/1.0.0',
    tenant: 'acme',
    project: 'petstore',
    version: '1.0.0',
    signed: true,
  });
});

test('parseReady tolerates a root mount and missing fields', () => {
  assert.equal(parseReady({ runtime: { mount: '/' } }).mount, '');
  assert.equal(parseReady({}).digest, '');
  assert.equal(parseReady(null).runtimeVersion, '');
  assert.equal(parseReady({ runtime: { mount: '/acme/p/1.0.0/' } }).mount, '/acme/p/1.0.0');
});

test('serviceUrl joins the runtime root and its version mount', () => {
  assert.equal(serviceUrl('http://127.0.0.1:8775', '/acme/p/1.0.0'), 'http://127.0.0.1:8775/acme/p/1.0.0');
  assert.equal(serviceUrl('http://127.0.0.1:8775/', '/acme/p/1.0.0'), 'http://127.0.0.1:8775/acme/p/1.0.0');
  assert.equal(serviceUrl('http://127.0.0.1:8775', ''), 'http://127.0.0.1:8775');
});

test('summaryMarkdown reports the digests a reader needs to trust the run', () => {
  const markdown = summaryMarkdown({
    serviceUrl: 'http://127.0.0.1:8775/acme/petstore/1.0.0',
    image: 'ghcr.io/apiome/apiome-mock:0.5.0',
    runtimeVersion: '0.5.0',
    digest: 'sha256:abc',
    signed: false,
    tenant: 'acme',
    project: 'petstore',
    version: '1.0.0',
  });
  assert.match(markdown, /### Apiome mock runtime/);
  assert.match(markdown, /`sha256:abc`/);
  assert.match(markdown, /ghcr\.io\/apiome\/apiome-mock:0\.5\.0/);
  assert.match(markdown, /\| Bundle signed \| no \|/);
  assert.match(markdown, /acme \/ petstore \/ 1\.0\.0/);
});

test('summaryMarkdown says so when the runtime reported nothing', () => {
  const markdown = summaryMarkdown({ serviceUrl: 'http://127.0.0.1:1', image: 'img' });
  assert.match(markdown, /\(not reported\)/);
});

test('outputLine uses the heredoc form so a value cannot inject another output', () => {
  assert.equal(outputLine('service-url', 'http://x', 'DELIM'), 'service-url<<DELIM\nhttp://x\nDELIM\n');
  const injected = outputLine('a', 'x\nb=evil', 'DELIM');
  assert.equal(injected, 'a<<DELIM\nx\nb=evil\nDELIM\n');
});
