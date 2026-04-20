const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const immichFileSystemModulePath = path.resolve(__dirname, '..', 'dist', 'immich-file-system.js');
const execFileAsync = promisify(execFile);

test('token login via username supports bearer tokens', async () => {
  const requests = [];
  const server = await startMockServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (req.method === 'GET' && req.url === '/api/users/me') {
      if (req.headers.authorization === 'Bearer bearer-token-value') {
        return json(res, 200, { id: 'user-1', email: 'bearer@example.com', username: 'bearer-user' });
      }
      return json(res, 401, { message: 'Unauthorized' });
    }

    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, []);
    }

    return json(res, 404, { message: 'Not found' });
  });

  try {
    await runImmichSession(server.baseUrl, 'bearer-token-value', '');
  } finally {
    await server.close();
  }

  assert.ok(requests.some((r) => r.method === 'GET' && r.url === '/api/users/me' && r.headers.authorization === 'Bearer bearer-token-value'));
  assert.ok(requests.some((r) => r.method === 'GET' && r.url === '/api/albums' && r.headers.authorization === 'Bearer bearer-token-value'));
});

test('token login via username supports API keys', async () => {
  const requests = [];
  let usersMeCalls = 0;
  const server = await startMockServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (req.method === 'GET' && req.url === '/api/users/me') {
      usersMeCalls += 1;
      if (usersMeCalls === 1) {
        return json(res, 401, { message: 'Unauthorized bearer' });
      }
      if (req.headers['x-api-key'] === 'immich-api-key-value') {
        return json(res, 200, { id: 'user-2', email: 'api-key@example.com', username: 'api-key-user' });
      }
      return json(res, 401, { message: 'Unauthorized api key' });
    }

    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, []);
    }

    return json(res, 404, { message: 'Not found' });
  });

  try {
    await runImmichSession(server.baseUrl, 'immich-api-key-value', '');
  } finally {
    await server.close();
  }

  assert.ok(requests.some((r) => r.method === 'GET' && r.url === '/api/users/me' && r.headers.authorization === 'Bearer immich-api-key-value'));
  assert.ok(requests.some((r) => r.method === 'GET' && r.url === '/api/users/me' && r.headers['x-api-key'] === 'immich-api-key-value'));
  assert.ok(requests.some((r) => r.method === 'GET' && r.url === '/api/albums' && r.headers['x-api-key'] === 'immich-api-key-value'));
});

test('email/password login keeps auth/login flow', async () => {
  const requests = [];
  const server = await startMockServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (req.method === 'POST' && req.url === '/api/auth/login') {
      const payload = body ? JSON.parse(body) : {};
      if (payload.email === 'user@example.com' && payload.password === 'secret') {
        return json(res, 200, {
          accessToken: 'session-token',
          user: { id: 'user-3', email: 'user@example.com', username: 'user' },
        });
      }
      return json(res, 401, { message: 'Invalid credentials' });
    }

    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, []);
    }

    if (req.method === 'POST' && req.url === '/api/auth/logout') {
      return json(res, 200, {});
    }

    return json(res, 404, { message: 'Not found' });
  });

  try {
    await runImmichSession(server.baseUrl, 'user@example.com', 'secret');
  } finally {
    await server.close();
  }

  assert.ok(requests.some((r) => r.method === 'POST' && r.url === '/api/auth/login'));
  assert.ok(requests.some((r) => r.method === 'GET' && r.url === '/api/albums' && r.headers.authorization === 'Bearer session-token'));
  assert.ok(requests.some((r) => r.method === 'POST' && r.url === '/api/auth/logout' && r.headers.authorization === 'Bearer session-token'));
});

async function runImmichSession(immichHost, username, password) {
  const script = `
const { ImmichFileSystem } = require(${JSON.stringify(immichFileSystemModulePath)});
(async () => {
  const fsBackend = new ImmichFileSystem();
  await fsBackend.login(${JSON.stringify(username)}, ${JSON.stringify(password)});
  await fsBackend.listFiles('/');
  await fsBackend.logout();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  await execFileAsync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      IMMICH_HOST: immichHost,
      TZ: 'UTC',
      ENABLE_SFTP: 'false',
      ENABLE_FTP: 'false',
    },
  });
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
