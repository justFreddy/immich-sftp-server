const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ftpServerModulePath = path.resolve(__dirname, '..', 'dist', 'ftp-server.js');

function getFtpOptions(extraEnv = {}) {
  const script = `
const { buildFtpServerOptions } = require(${JSON.stringify(ftpServerModulePath)});
process.stdout.write(JSON.stringify(buildFtpServerOptions()));
`;

  const out = execFileSync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      IMMICH_HOST: 'http://immich.local',
      ENABLE_FTP: 'true',
      ...extraEnv,
    },
  }).toString();

  return JSON.parse(out);
}

test('FTP defaults keep active-mode configuration only', () => {
  const options = getFtpOptions({
    LISTEN_HOST: '0.0.0.0',
    FTP_PORT: '21',
    FTP_PASSIVE_HOST: '',
    FTP_PASSIVE_PORT_MIN: '',
    FTP_PASSIVE_PORT_MAX: '',
  });

  assert.deepEqual(options, {
    url: 'ftp://0.0.0.0:21',
  });
});

test('FTP can be configured for passive mode', () => {
  const options = getFtpOptions({
    LISTEN_HOST: '0.0.0.0',
    FTP_PORT: '21',
    FTP_PASSIVE_HOST: 'ftp.example.com',
    FTP_PASSIVE_PORT_MIN: '30000',
    FTP_PASSIVE_PORT_MAX: '30010',
  });

  assert.deepEqual(options, {
    url: 'ftp://0.0.0.0:21',
    pasv_url: 'ftp.example.com',
    pasv_min: 30000,
    pasv_max: 30010,
  });
});
