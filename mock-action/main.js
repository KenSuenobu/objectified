'use strict';
/**
 * Main step of the Apiome mock CI action (#4748, PMR-3.1).
 *
 * Starts a version-pinned portable mock runtime as a detached container, waits for it to report
 * readiness, and publishes what the rest of the job needs: a loopback-only service URL and the
 * runtime/bundle digests that say *which artifact* answered the suite. The container name is
 * handed to `post.js` through the action state file, so the runtime is removed when the job ends
 * whether the job passed, failed, or was cancelled.
 *
 * Written against the Node standard library only — no bundler, no vendored `node_modules`, so
 * what runs on the runner is exactly what is committed and reviewable here.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');

const {
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
} = require('./lib');

/**
 * Read a GitHub Action input.
 *
 * @param {string} name Input name as declared in action.yml.
 * @returns {string} The raw value ("" when unset).
 */
function input(name) {
  return process.env[`INPUT_${name.toUpperCase().replace(/[ -]/g, '_')}`] ?? '';
}

/**
 * Append entries to a GitHub Actions file command (outputs, state, summary).
 *
 * @param {string} envName Environment variable naming the file.
 * @param {string} text Text to append.
 */
function appendFile(envName, text) {
  const target = process.env[envName];
  if (target) {
    fs.appendFileSync(target, text, 'utf8');
  }
}

/**
 * Publish one step output.
 *
 * @param {string} name Output name.
 * @param {string} value Output value.
 */
function setOutput(name, value) {
  appendFile('GITHUB_OUTPUT', outputLine(name, String(value), `ghadelim_${crypto.randomBytes(8).toString('hex')}`));
}

/**
 * Record state for the post step.
 *
 * @param {string} name State name.
 * @param {string} value State value.
 */
function saveState(name, value) {
  appendFile('GITHUB_STATE', outputLine(name, String(value), `ghadelim_${crypto.randomBytes(8).toString('hex')}`));
}

/**
 * Run a command, returning its result without throwing.
 *
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @param {object} [options] Extra spawn options (for example a modified environment).
 * @returns {{status: number, stdout: string, stderr: string}} The outcome.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.error?.message ?? ''),
  };
}

/**
 * Reserve a free TCP port by binding port 0 and releasing it.
 *
 * There is an unavoidable race between releasing the port and Docker binding it; picking a fresh
 * port is still far better than a fixed default, which collides deterministically whenever two
 * jobs share a runner.
 *
 * @returns {Promise<number>} A port that was free a moment ago.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Fetch a URL and return its status and body.
 *
 * @param {string} url URL to request.
 * @param {number} timeoutMs Per-request timeout.
 * @returns {Promise<{status: number, body: string}>} The response.
 */
function fetchUrl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
  });
}

/**
 * Poll `/ready` until the runtime reports readiness.
 *
 * @param {string} baseUrl Root URL of the runtime.
 * @param {number} waitSeconds How long to keep polling.
 * @param {string} container Container name, polled for early exit.
 * @returns {Promise<any>} The parsed `/ready` document.
 * @throws {Error} When the runtime never became ready, or exited while starting.
 */
async function waitForReady(baseUrl, waitSeconds, container) {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    const running = run('docker', ['inspect', '-f', '{{.State.Running}}', container]);
    if (running.status === 0 && running.stdout.trim() === 'false') {
      // A bundle the runtime refuses (unsigned when required, tampered, incompatible) exits
      // immediately; polling until the timeout would hide a failure that is already decided.
      throw new Error('the mock runtime exited while starting; see the container logs above.');
    }
    try {
      const response = await fetchUrl(`${baseUrl}/ready`, 2000);
      if (response.status === 200) {
        return JSON.parse(response.body);
      }
      lastError = `/ready answered ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the mock runtime did not become ready within ${waitSeconds}s (${lastError}).`);
}

/**
 * Start the runtime, publish its identity, and optionally prove it against the shared corpus.
 *
 * @returns {Promise<void>} Resolves when the runtime is ready and outputs are published.
 */
async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const bundlePath = resolveBundlePath(input('bundle'), workspace);
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Bundle not found at ${bundlePath}.`);
  }

  const image = String(input('image')).trim() || 'ghcr.io/apiome/apiome-mock:latest';
  const host = resolveHost(input('host'));
  const requested = resolvePort(input('port'));
  const port = requested === 0 ? await freePort() : requested;
  const waitSeconds = resolveWait(input('wait'));
  const secret = String(input('bundle-secret'));
  const name = containerName(process.env, crypto.randomBytes(4).toString('hex'));

  if (parseBool(input('pull'))) {
    const pulled = run('docker', ['pull', image]);
    if (pulled.status !== 0) {
      throw new Error(`Could not pull ${image}: ${pulled.stderr.trim()}`);
    }
  }

  // Saved before starting: a container that starts and then fails readiness must still be cleaned
  // up by the post step.
  saveState('container', name);

  const args = dockerRunArgs({
    name,
    image,
    bundlePath,
    host,
    port,
    requireSignature: parseBool(input('require-signature')),
    hasSecret: Boolean(secret),
  });
  // The secret reaches the container through the environment, never through argv.
  const started = run('docker', args, { env: { ...process.env, [SECRET_ENV]: secret } });
  if (started.status !== 0) {
    throw new Error(`Could not start ${image}: ${started.stderr.trim()}`);
  }

  const baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  let ready;
  try {
    ready = await waitForReady(baseUrl, waitSeconds, name);
  } catch (error) {
    const logs = run('docker', ['logs', name]);
    process.stderr.write(`${logs.stdout}${logs.stderr}\n`);
    throw error;
  }

  const identity = parseReady(ready);
  const url = serviceUrl(baseUrl, identity.mount);

  setOutput('service-url', url);
  setOutput('base-url', baseUrl);
  setOutput('mount', identity.mount);
  setOutput('bundle-digest', identity.digest);
  setOutput('runtime-version', identity.runtimeVersion);
  setOutput('container', name);
  setOutput('port', String(port));

  appendFile('GITHUB_STEP_SUMMARY', summaryMarkdown({ ...identity, serviceUrl: url, image }));
  process.stdout.write(
    `Apiome mock ready at ${url}\n` +
      `  image    ${image}\n` +
      `  runtime  ${identity.runtimeVersion || '(not reported)'}\n` +
      `  bundle   ${identity.digest || '(not reported)'}\n`,
  );

  if (parseBool(input('conformance'))) {
    const report = run('docker', conformanceArgs(name));
    process.stdout.write(report.stdout);
    if (report.status !== 0) {
      process.stderr.write(report.stderr);
      throw new Error('The started runtime failed the shared mock conformance corpus.');
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
