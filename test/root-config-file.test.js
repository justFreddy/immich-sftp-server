const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const immichFileSystemModulePath = path.resolve(__dirname, '..', 'dist', 'immich-file-system.js');
const execFileAsync = promisify(execFile);

test('root listing always exposes config.yaml and persists user settings file', async () => {
  const requests = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-ns-root-config-'));
  const settingsFile = path.join(tmpDir, 'immich-network-storage.yaml');
  fs.writeFileSync(settingsFile, 'asset:\n  fileNamePattern: original\n', 'utf8');

  const server = await startMockServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body });

    if (req.method === 'POST' && req.url === '/api/auth/login') {
      return json(res, 200, {
        accessToken: 'session-access-token',
        user: { id: '550e8400-e29b-41d4-a716-446655440000', email: 'user@example.com', username: 'user' },
      });
    }
    if (req.method === 'GET' && req.url === '/api/users/me/preferences') {
      return json(res, 200, {});
    }
    if (req.method === 'POST' && req.url === '/api/auth/logout') {
      return json(res, 200, {});
    }

    return json(res, 404, { message: 'Not found' });
  });

  try {
    const names = await listRootNames(server.baseUrl, settingsFile);
    assert.ok(names.includes('albums'));
    assert.ok(names.includes('config.yaml'));

    const perUserSettingsPath = path.join(tmpDir, 'immich-network-storage.550e8400-e29b-41d4-a716-446655440000.yaml');
    assert.equal(fs.existsSync(perUserSettingsPath), true);
  } finally {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.ok(requests.some((r) => r.method === 'POST' && r.url === '/api/auth/login'));
  assert.ok(requests.some((r) => r.method === 'POST' && r.url === '/api/auth/logout'));
});

async function listRootNames(immichHost, settingsFile) {
  const script = `
const { ImmichFileSystem } = require(${JSON.stringify(immichFileSystemModulePath)});
(async () => {
  const fsBackend = new ImmichFileSystem();
  await fsBackend.login('user@example.com', 'secret');
  const entries = await fsBackend.listFiles('/');
  await fsBackend.logout();
  process.stdout.write(JSON.stringify(entries.map((entry) => entry.name)));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      IMMICH_HOST: immichHost,
      SETTINGS_FILE: settingsFile,
      TZ: 'UTC',
      ENABLE_SFTP: 'false',
      ENABLE_FTP: 'false',
    },
  });

  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  if (!lastLine) {
    throw new Error('No JSON output received from listRootNames script.');
  }
  return JSON.parse(lastLine);
}

function startMockServer(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      handler(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to determine listening port.'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) {
              closeReject(error);
              return;
            }
            closeResolve();
          });
        }),
      });
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
