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
  enableWebdav: config.enableWebdav,
  webdavPort: config.webdavPort,
  assetFileNamePattern: config.assetFileNamePattern,
  assetDownloadSource: config.assetDownloadSource,
  enableTagsFolderDefault: config.enableTagsFolderDefault,
  enablePeopleFolderDefault: config.enablePeopleFolderDefault
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

function readUserSettings(userId, extraEnv = {}, cwd = path.resolve(__dirname, '..')) {
  const script = `
const { loadSettingsForUser } = require(${JSON.stringify(configModulePath)});
process.stdout.write(JSON.stringify(loadSettingsForUser(${JSON.stringify(userId)})));
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

test('asset settings can be read from root YAML file', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-ns-config-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpDir, 'immich-network-storage.yaml'), `asset:
  fileNamePattern: short_uuid
  downloadSource: preview
`);

  const config = readConfig({}, tmpDir);
  assert.deepEqual(config, {
    enableWebdav: false,
    webdavPort: 1900,
    assetFileNamePattern: 'shortUuid',
    assetDownloadSource: 'preview',
    enableTagsFolderDefault: true,
    enablePeopleFolderDefault: true,
  });
});

test('environment variables override YAML asset settings', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-ns-config-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpDir, 'immich-network-storage.yaml'), `asset:
  fileNamePattern: original
  downloadSource: original
`);

  const config = readConfig({
    ASSET_FILENAME_PATTERN: 'date_uuid',
    ASSET_DOWNLOAD_SOURCE: 'preview',
    ENABLE_WEBDAV: '1',
    WEBDAV_PORT: '8080',
    ENABLE_TAGS_FOLDER_DEFAULT: 'false',
    ENABLE_PEOPLE_FOLDER_DEFAULT: '0',
  }, tmpDir);

  assert.deepEqual(config, {
    enableWebdav: true,
    webdavPort: 8080,
    assetFileNamePattern: 'dateUuid',
    assetDownloadSource: 'preview',
    enableTagsFolderDefault: false,
    enablePeopleFolderDefault: false,
  });
});

test('virtual folder defaults can be read from root YAML file', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-ns-config-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpDir, 'immich-network-storage.yaml'), `virtualFolders:
  tags:
    enabledDefault: false
  people:
    enabledDefault: true
`);

  const config = readConfig({}, tmpDir);
  assert.deepEqual(config, {
    enableWebdav: false,
    webdavPort: 1900,
    assetFileNamePattern: 'original',
    assetDownloadSource: 'original',
    enableTagsFolderDefault: false,
    enablePeopleFolderDefault: true,
  });
});

test('per-user YAML settings file overrides root settings for that user', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-ns-config-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpDir, 'immich-network-storage.yaml'), `asset:
  fileNamePattern: original
  downloadSource: original
virtualFolders:
  tags:
    enabledDefault: true
  people:
    enabledDefault: true
`);
  // per-user settings file named by Immich user ID (UUID)
  fs.writeFileSync(path.join(tmpDir, 'immich-network-storage.550e8400-e29b-41d4-a716-446655440000.yaml'), `asset:
  fileNamePattern: short_uuid
  downloadSource: preview
virtualFolders:
  tags:
    enabledDefault: false
  people:
    enabledDefault: false
`);

  const userSettings = readUserSettings('550e8400-e29b-41d4-a716-446655440000', {}, tmpDir);
  assert.deepEqual(userSettings, {
    assetFileNamePattern: 'shortUuid',
    assetDownloadSource: 'preview',
    enableTagsFolderDefault: false,
    enablePeopleFolderDefault: false,
  });

  const otherUserSettings = readUserSettings('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {}, tmpDir);
  assert.deepEqual(otherUserSettings, {
    assetFileNamePattern: 'original',
    assetDownloadSource: 'original',
    enableTagsFolderDefault: true,
    enablePeopleFolderDefault: true,
  });

  // non-UUID value is ignored (security guard), falls back to global settings
  const nonUuidSettings = readUserSettings('not-a-uuid', {}, tmpDir);
  assert.deepEqual(nonUuidSettings, {
    assetFileNamePattern: 'original',
    assetDownloadSource: 'original',
    enableTagsFolderDefault: true,
    enablePeopleFolderDefault: true,
  });
});

test('{userId} placeholder in SETTINGS_FILE resolves to per-user file', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-ns-config-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpDir, 'settings.550e8400-e29b-41d4-a716-446655440000.yaml'), `asset:
  fileNamePattern: date
`);

  const userId = '550e8400-e29b-41d4-a716-446655440000';
  const settingsFile = path.join(tmpDir, 'settings.{userId}.yaml');
  const userSettings = readUserSettings(userId, { SETTINGS_FILE: settingsFile }, tmpDir);
  assert.equal(userSettings.assetFileNamePattern, 'date');
});
