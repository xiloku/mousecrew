// rmrf.js — fs.rmSync that tolerates Windows' async file-handle release.
//
// On Windows, closing a better-sqlite3 WAL database releases the handle synchronously as
// far as the API is concerned, but the OS can lag unmapping the memory-mapped -wal/-shm
// files for a few milliseconds after close() returns. A test that closes the db and
// immediately rmSync()s its temp directory then hits EPERM/EBUSY on the directory even
// though nothing in the code is still holding the file open. This is purely a teardown
// race, not a leaked handle (the db is genuinely closed), so the right fix is to retry the
// removal briefly rather than skip the test or change product code.
//
// On POSIX there is no such race; the first attempt succeeds and this is a thin wrapper.

const fs = require('fs');

/**
 * Recursively remove a path, retrying on the transient Windows locks EPERM/EBUSY/ENOTEMPTY.
 * @param {string} target path to remove
 */
function rmrfSync(target) {
  // node's own rmSync retries internally, but its default retryDelay/maxRetries are tuned
  // for the common case; bump them so the sqlite mmap release always lands within the window.
  try {
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50, // up to ~1s total, far longer than the mmap-release lag
    });
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY')) {
      // Last-ditch: a short synchronous spin, then one more attempt. Keeps the test from
      // flaking on a slow machine without leaving the temp dir behind.
      const until = Date.now() + 1000;
      while (Date.now() < until) { /* spin */ }
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      return;
    }
    throw e;
  }
}

module.exports = { rmrfSync };
