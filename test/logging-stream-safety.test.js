const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

process.env.IMMICH_HOST ||= 'http://immich.local';

const { ImmichFileSystem } = require('../dist/immich-file-system.js');

test('filterLogData handles stream responses without recursion', () => {
  const fsBackend = new ImmichFileSystem();
  const stream = new PassThrough();

  const masked = fsBackend.filterLogData(stream);
  assert.equal(masked, '[Stream]');
});
