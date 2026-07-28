'use strict';
/**
 * Pure helpers for the Apiome mock CI action (#4748, PMR-3.1).
 *
 * Everything here is free of I/O and process state so it can be unit-tested directly: argument
 * construction, workspace-relative path safety, readiness parsing, and the strings the action
 * writes to GitHub outputs and the job summary. `main.js` and `post.js` hold the side effects.
 */

const path = require('path');

/** Port the runtime listens on inside the container image. */
const CONTAINER_PORT = 8775;

/** Path the image expects a mounted bundle at (its documented default). */
const CONTAINER_BUNDLE_PATH = '/bundle/mock-bundle.json';

/** Environment variable carrying the bundle signing secret into the container. */
const SECRET_ENV = 'APIOME_MOCK_BUNDLE_SECRET';

/**
 * Interpret a GitHub Action boolean input.
 *
 * Action inputs are always strings, and an unset input arrives as "". Anything other than a
 * recognized true value is false, so a typo never silently enables a behavior.
 *
 * @param {string|undefined} value Raw input value.
 * @returns {boolean} Whether the input reads as true.
 */
function parseBool(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Resolve the bundle path and refuse anything outside the workspace.
 *
 * A workflow controls this input, but it is still an untrusted string on a shared runner: without
 * this check a bundle input of `../../.ssh/id_rsa` would be bind-mounted into a container.
 *
 * @param {string} input Raw `bundle` input (workspace-relative or absolute).
 * @param {string} workspace Absolute path of the checked-out workspace.
 * @returns {string} The absolute bundle path.
 * @throws {Error} When the input is empty or resolves outside the workspace.
 */
function resolveBundlePath(input, workspace) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('Input "bundle" is required: give the path of the mock bundle to serve.');
  }
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, raw);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Input "bundle" (${raw}) resolves outside the workspace and was refused.`);
  }
  return resolved;
}

/**
 * Validate a published host interface.
 *
 * @param {string} value Raw `host` input.
 * @returns {string} The host to publish on (defaults to loopback).
 * @throws {Error} When the value contains characters that are not host-shaped.
 */
function resolveHost(value) {
  const host = String(value ?? '').trim() || '127.0.0.1';
  if (!/^[A-Za-z0-9.:_-]+$/.test(host)) {
    throw new Error(`Input "host" (${host}) is not a valid host address.`);
  }
  return host;
}

/**
 * Validate a requested host port.
 *
 * @param {string|number} value Raw `port` input; 0 means "pick a free port".
 * @returns {number} The requested port.
 * @throws {Error} When the value is not an integer in range.
 */
function resolvePort(value) {
  const raw = String(value ?? '').trim() || '0';
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Input "port" (${raw}) must be a non-negative integer.`);
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new Error(`Input "port" (${raw}) must be between 0 and 65535.`);
  }
  return port;
}

/**
 * Validate the readiness wait.
 *
 * @param {string|number} value Raw `wait` input, in seconds.
 * @returns {number} Seconds to wait for readiness.
 * @throws {Error} When the value is not a positive number.
 */
function resolveWait(value) {
  const seconds = Number(String(value ?? '').trim() || '60');
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Input "wait" (${value}) must be a positive number of seconds.`);
  }
  return seconds;
}

/**
 * Build a container name that is unique per job and per action step.
 *
 * @param {Record<string, string|undefined>} env Process environment (GitHub run identifiers).
 * @param {string} suffix Random suffix, so two steps in one job never collide.
 * @returns {string} The container name.
 */
function containerName(env, suffix) {
  const run = String(env.GITHUB_RUN_ID ?? 'local').replace(/[^A-Za-z0-9_.-]/g, '');
  return `apiome-mock-${run || 'local'}-${suffix}`;
}

/**
 * Build the `docker run` argument list that starts the runtime.
 *
 * The bundle is mounted read-only, the port is published on the requested interface (loopback by
 * default, so the mock is reachable from the job and from nothing else), and the signing secret —
 * when configured — is forwarded **by name**: a value on a command line is readable by every
 * process on the runner through the process table.
 *
 * @param {object} options Start options.
 * @param {string} options.name Container name.
 * @param {string} options.image Runtime image reference.
 * @param {string} options.bundlePath Absolute host path of the bundle.
 * @param {string} options.host Host interface to publish on.
 * @param {number} options.port Host port to publish.
 * @param {boolean} [options.requireSignature] Refuse an unsigned bundle.
 * @param {boolean} [options.hasSecret] Whether a signing secret is configured.
 * @returns {string[]} Arguments for `docker`.
 */
function dockerRunArgs({ name, image, bundlePath, host, port, requireSignature = false, hasSecret = false }) {
  const args = [
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    `${host}:${port}:${CONTAINER_PORT}`,
    '--volume',
    `${bundlePath}:${CONTAINER_BUNDLE_PATH}:ro`,
  ];
  if (hasSecret) {
    args.push('--env', SECRET_ENV);
  }
  if (requireSignature) {
    args.push('--env', 'APIOME_MOCK_REQUIRE_SIGNATURE=true');
  }
  args.push(image, 'run');
  return args;
}

/**
 * Build the `docker exec` argument list that runs the shared corpus inside the started container.
 *
 * The image carries both the runtime and the corpus, so the check needs nothing mounted and no
 * network egress — it addresses the runtime on the container's own loopback interface.
 *
 * @param {string} container Container name.
 * @returns {string[]} Arguments for `docker`.
 */
function conformanceArgs(container) {
  return ['exec', container, 'apiome-mock', 'conformance', '--base-url', `http://127.0.0.1:${CONTAINER_PORT}`];
}

/**
 * Extract the identity a job should record from the runtime's `/ready` document.
 *
 * @param {any} document Parsed `/ready` response.
 * @returns {{digest: string, runtimeVersion: string, mount: string, tenant: string, project: string, version: string, signed: boolean}}
 *   The runtime and bundle identity, with empty strings for anything the runtime did not report.
 */
function parseReady(document) {
  const runtime = (document && document.runtime) || {};
  const bundle = (document && document.bundle) || {};
  const mount = typeof runtime.mount === 'string' && runtime.mount !== '/' ? runtime.mount.replace(/\/$/, '') : '';
  return {
    digest: String(bundle.digest ?? ''),
    runtimeVersion: String(runtime.version ?? ''),
    mount,
    tenant: String(bundle.tenant ?? ''),
    project: String(bundle.project ?? ''),
    version: String(bundle.version ?? ''),
    signed: Boolean(bundle.signed),
  };
}

/**
 * Join the runtime root URL and its version mount into the URL steps should call.
 *
 * @param {string} baseUrl Root URL of the runtime.
 * @param {string} mount Version mount prefix, or "" when the spec is served at the root.
 * @returns {string} The service URL, without a trailing slash.
 */
function serviceUrl(baseUrl, mount) {
  return `${String(baseUrl).replace(/\/$/, '')}${mount || ''}`;
}

/**
 * Render the job-summary block reporting what the job is testing against.
 *
 * The digests are the point: a green suite means nothing if nobody can tell which artifact
 * answered it.
 *
 * @param {object} identity Values from {@link parseReady} plus the resolved URLs and image.
 * @returns {string} Markdown for `$GITHUB_STEP_SUMMARY`.
 */
function summaryMarkdown(identity) {
  const rows = [
    ['Service URL', identity.serviceUrl],
    ['Image', identity.image],
    ['Runtime version', identity.runtimeVersion || '(not reported)'],
    ['Bundle digest', identity.digest ? `\`${identity.digest}\`` : '(not reported)'],
    ['Bundle signed', identity.signed ? 'yes' : 'no'],
    ['API', [identity.tenant, identity.project, identity.version].filter(Boolean).join(' / ') || '(not reported)'],
  ];
  const body = rows.map(([label, value]) => `| ${label} | ${value} |`).join('\n');
  return ['### Apiome mock runtime', '', '| | |', '|---|---|', body, ''].join('\n');
}

/**
 * Render one `$GITHUB_OUTPUT` entry using the heredoc form.
 *
 * The delimiter form is used for every value, so a value that ever grows a newline cannot inject
 * additional outputs.
 *
 * @param {string} name Output name.
 * @param {string} value Output value.
 * @param {string} delimiter Unique delimiter token.
 * @returns {string} The text to append to the output file.
 */
function outputLine(name, value, delimiter) {
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

module.exports = {
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
};
