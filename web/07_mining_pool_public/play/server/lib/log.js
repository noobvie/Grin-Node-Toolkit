'use strict';

// One-line, timestamped log records. systemd appends stdout/stderr to the games log
// (design §19.12), so a record is exactly one line: a message with a newline in it would
// forge a second record, which is why every message is flattened.
//
// Never pass a secret, a session token, a proof or a request body in here. Nothing in
// this module can tell those apart from ordinary text, so the rule is enforced at the
// call sites: log codes and ids, not values.

function flatten(msg) {
  return String(msg).replace(/[\r\n\u2028\u2029]+/g, ' ');
}

// sink(level, line) — tests pass one that collects instead of printing.
function createLogger(sink) {
  const out = sink || ((level, line) => {
    if (level === 'info') process.stdout.write(line + '\n');
    else process.stderr.write(line + '\n');
  });
  const emit = (level) => (msg) => {
    out(level, `${new Date().toISOString()} ${level.toUpperCase()} ${flatten(msg)}`);
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

module.exports = { createLogger };
