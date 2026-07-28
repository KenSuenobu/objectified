'use strict';
/**
 * Post step of the Apiome mock CI action (#4748, PMR-3.1).
 *
 * GitHub runs this after every job that used the action — success, failure, or cancellation — so
 * the started runtime is always removed. The container's logs are attached first, inside a
 * collapsed group: once the container is gone they are the only record of why the mock answered
 * as it did, and a post step has no reliable way to know whether the job passed (GitHub exposes no
 * job-status variable here), so they are always attached and collapsed rather than guessed at.
 */

const { spawnSync } = require('child_process');

/**
 * Run a command, returning its result without throwing.
 *
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @returns {{status: number, stdout: string, stderr: string}} The outcome.
 */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.error?.message ?? ''),
  };
}

/**
 * Remove the container started by the main step.
 *
 * Cleanup never fails the job: the runtime is ephemeral, and a container that is already gone (an
 * earlier failure, a runner reaping containers itself) is the outcome this step wanted anyway.
 *
 * @returns {void}
 */
function main() {
  const container = String(process.env.STATE_container ?? '').trim();
  if (!container) {
    return;
  }

  const logs = run('docker', ['logs', '--tail', '200', container]);
  if (logs.stdout || logs.stderr) {
    // ::group:: renders collapsed in the run view: available when a failure needs explaining,
    // out of the way when it does not.
    process.stdout.write(`::group::Apiome mock runtime logs (${container})\n`);
    process.stdout.write(`${logs.stdout}${logs.stderr}\n`);
    process.stdout.write('::endgroup::\n');
  }

  const removed = run('docker', ['rm', '--force', container]);
  if (removed.status === 0) {
    process.stdout.write(`Removed Apiome mock runtime container ${container}.\n`);
    return;
  }
  process.stdout.write(`Apiome mock runtime container ${container} was already gone.\n`);
}

main();
