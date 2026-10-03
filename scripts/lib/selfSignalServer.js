'use strict';

/**
 * Shutdown harness for the smoke test.
 *
 * `server.js` only bootstraps when it is the entry point, so this wrapper calls
 * the same exported functions and then re-emits SIGTERM.
 *
 * Needed on Windows, where OS-level signals do not exist: `child.kill('SIGTERM')`
 * there calls TerminateProcess (the handler never runs, exit code is null), and
 * `process.kill(process.pid, 'SIGTERM')` behaves the same way. `process.emit`
 * invokes the exact listener that `process.on('SIGTERM', ...)` registered, so the
 * full graceful-shutdown path is genuinely exercised.
 *
 * Not part of the app; used only by scripts/smoke.js.
 */

const readline = require('readline');
const { bootstrap } = require('../../server');

(async () => {
  await bootstrap();

  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === 'SIGTERM') {
      process.emit('SIGTERM');
    }
  });
})();
