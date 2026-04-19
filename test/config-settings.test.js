const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configModulePath = path.resolve(__dirname, '..', 'dist', 'config.js');

function readConfig(extraEnv = {}, cwd = path.resolve(__dirname, '..')) {
  const script = `
const { config } = require(${JSON.stringify(configModulePath)});
process.stdout.write(JSON.stringify({
  assetFileNamePattern: config.assetFileNamePattern,
  assetDownloadSource: config.assetDownloadSource
}));
`;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd,
    env: {
      ...process.env,
      IMMICH_HOST: 'http://immich.local',
      ...extraEnv,
    },
  }).toString();
  return JSON.parse(output);
}

test('asset settings can be read from root YAML file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-sftp-config-'));
  fs.writeFileSync(path.join(tmpDir, 'immich-sftp-server.yaml'), `
asset:
  fileNamePattern: short_uuid
  downloadSource: preview
`);

  const config = readConfig({}, tmpDir);
  assert.deepEqual(config, {
    assetFileNamePattern: 'shortUuid',
    assetDownloadSource: 'preview',
  });
});

test('environment variables override YAML asset settings', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-sftp-config-'));
  fs.writeFileSync(path.join(tmpDir, 'immich-sftp-server.yaml'), `
asset:
  fileNamePattern: original
  downloadSource: original
`);

  const config = readConfig({
    ASSET_FILENAME_PATTERN: 'date_uuid',
    ASSET_DOWNLOAD_SOURCE: 'preview',
  }, tmpDir);

  assert.deepEqual(config, {
    assetFileNamePattern: 'dateUuid',
    assetDownloadSource: 'preview',
  });
});
