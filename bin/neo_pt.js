'use strict';
/* PTY/interaction test entry: patches runAgent with a slow fake agent so ESC
   abort, input-field visibility and diff boxes can be exercised without the API. */
process.env.NEO_TUI_TEST = '1';
const core = require('../core');
core.runAgent = async function (msgs, emit, opts) {
  emit({ type: 'iteration', n: 1 });
  emit({ type: 'tool_start', id: 't1', name: 'edit_file', args: { path: '/home/app.js' } });
  emit({
    type: 'tool_done',
    id: 't1',
    name: 'edit_file',
    ok: true,
    output: 'Edited: /home/app.js',
    diff: {
      path: '/home/app.js',
      additions: 2,
      deletions: 1,
      lines: [
        { t: 'ctx', text: 'const server = http.createServer();' },
        { t: 'del', text: 'const port = 3000;' },
        { t: 'add', text: 'const port = process.env.PORT || 3000;' },
        { t: 'add', text: 'server.listen(port, () => log(`up ${port}`));' },
        { t: 'ctx', text: 'module.exports = server;' },
      ],
    },
  });
  for (let i = 0; i < 90; i++) {
    if (opts && opts.isAborted && opts.isAborted()) { emit({ type: 'aborted' }); return { aborted: true }; }
    emit({ type: 'text', content: 'كلمة ' + i + ' ' });
    await new Promise((r) => setTimeout(r, 180));
  }
  return {};
};
require('../terminal/cli').main();