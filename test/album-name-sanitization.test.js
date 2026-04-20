const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const immichFileSystemModulePath = path.resolve(__dirname, '..', 'dist', 'immich-file-system.js');
const execFileAsync = promisify(execFile);

test('albums with symbols in their names are sanitized and returned as folder names', async () => {
  const albums = [
    { id: 'album-id-01', albumName: 'Holiday: Summer 2024', description: '', updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'album-id-02', albumName: 'Photos*Backup', description: '', updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'album-id-03', albumName: 'C:/My Album', description: '', updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'album-id-04', albumName: 'Normal Album', description: '', updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'album-id-05', albumName: 'What?Why<>|', description: '', updatedAt: '2024-01-01T00:00:00.000Z' },
  ];

  const server = await startMockServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/users/me') {
      return json(res, 200, { id: 'user-1', email: 'test@example.com', name: 'test' });
    }
    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, albums);
    }
    return json(res, 404, { message: 'Not found' });
  });

  let listedNames;
  try {
    listedNames = await runListAlbums(server.baseUrl);
  } finally {
    await server.close();
  }

  assert.ok(listedNames.includes('Holiday_ Summer 2024'), `Expected sanitized 'Holiday_ Summer 2024', got: ${JSON.stringify(listedNames)}`);
  assert.ok(listedNames.includes('Photos_Backup'), `Expected sanitized 'Photos_Backup', got: ${JSON.stringify(listedNames)}`);
  assert.ok(listedNames.includes('C__My Album'), `Expected sanitized 'C__My Album', got: ${JSON.stringify(listedNames)}`);
  assert.ok(listedNames.includes('Normal Album'), `Expected unchanged 'Normal Album', got: ${JSON.stringify(listedNames)}`);
  assert.ok(listedNames.includes('What_Why___'), `Expected sanitized 'What_Why___', got: ${JSON.stringify(listedNames)}`);
});

test('albums with symbols in their names can be stat\'d via the sanitized path', async () => {
  const albums = [
    { id: 'album-id-01', albumName: 'My: Album', description: '', updatedAt: '2024-06-01T00:00:00.000Z' },
  ];

  const server = await startMockServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/users/me') {
      return json(res, 200, { id: 'user-1', email: 'test@example.com', name: 'test' });
    }
    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, albums);
    }
    return json(res, 404, { message: 'Not found' });
  });

  let statResult;
  try {
    statResult = await runStatAlbum(server.baseUrl, '/albums/My_ Album');
  } finally {
    await server.close();
  }

  assert.ok(statResult !== null, 'Expected stat to return a non-null result for the sanitized album path');
  assert.equal(statResult.isDir, true);
});

async function runListAlbums(immichHost) {
  const script = `
const { ImmichFileSystem } = require(${JSON.stringify(immichFileSystemModulePath)});
console.log = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.warn = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.error = (...args) => process.stderr.write(args.join(' ') + '\\n');
(async () => {
  const fsBackend = new ImmichFileSystem();
  await fsBackend.login('apikey', 'test-key');
  const files = await fsBackend.listFiles('/albums');
  process.stdout.write(JSON.stringify(files.map(f => f.name)));
})().catch((error) => {
  process.stderr.write(String(error) + '\\n');
  process.exit(1);
});
`;

  const output = await execFileAsync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      IMMICH_HOST: immichHost,
      TZ: 'UTC',
      ENABLE_SFTP: 'false',
      ENABLE_FTP: 'false',
    },
  });
  return JSON.parse(output.stdout);
}

async function runStatAlbum(immichHost, albumPath) {
  const script = `
const { ImmichFileSystem } = require(${JSON.stringify(immichFileSystemModulePath)});
console.log = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.warn = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.error = (...args) => process.stderr.write(args.join(' ') + '\\n');
(async () => {
  const fsBackend = new ImmichFileSystem();
  await fsBackend.login('apikey', 'test-key');
  const result = await fsBackend.stat(${JSON.stringify(albumPath)});
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {
  process.stderr.write(String(error) + '\\n');
  process.exit(1);
});
`;

  const output = await execFileAsync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      IMMICH_HOST: immichHost,
      TZ: 'UTC',
      ENABLE_SFTP: 'false',
      ENABLE_FTP: 'false',
    },
  });
  return JSON.parse(output.stdout);
}

function startMockServer(handler) {
  const server = http.createServer((req, res) => {
    handler(req, res);
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
