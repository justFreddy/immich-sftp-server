const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');

const immichFileSystemModulePath = path.resolve(__dirname, '..', 'dist', 'immich-file-system.js');
const yamlModulePath = path.resolve(__dirname, '..', 'node_modules', 'yaml');
const execFileAsync = promisify(execFile);

function buildImmichSessionEnv(immichHost) {
  return {
    ...process.env,
    IMMICH_HOST: immichHost,
    TZ: 'UTC',
    ENABLE_SFTP: 'false',
    ENABLE_FTP: 'false',
    SETTINGS_FILE: path.join(os.tmpdir(), `immich-ns-album-tests-${process.pid}.yaml`),
  };
}

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

test('uploading an asset to a symbol-named album does not rename the album on the server', async () => {
  const album = { id: 'album-id-01', albumName: 'Holiday: Summer', description: '', updatedAt: '2024-01-01T00:00:00.000Z' };
  const patchRequests = [];

  const server = await startMockServer((req, res, body) => {
    if (req.method === 'GET' && req.url === '/api/users/me') {
      return json(res, 200, { id: 'user-1', email: 'test@example.com', name: 'test' });
    }
    if (req.method === 'GET' && req.url === '/api/users/me/preferences') {
      return json(res, 200, {});
    }
    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, [album]);
    }
    if (req.method === 'POST' && req.url === '/api/assets/bulk-upload-check') {
      return json(res, 200, { results: [{ action: 'accept' }] });
    }
    if (req.method === 'POST' && req.url === '/api/assets') {
      return json(res, 201, { id: 'new-asset-id' });
    }
    if (req.method === 'PUT' && req.url === '/api/albums/album-id-01/assets') {
      return json(res, 200, {});
    }
    if (req.method === 'PATCH' && req.url.startsWith('/api/albums/')) {
      patchRequests.push({ url: req.url, body: tryParseJson(body) });
      return json(res, 200, {});
    }
    return json(res, 404, { message: 'Not found' });
  });

  try {
    await runUploadAsset(server.baseUrl, '/albums/Holiday_ Summer/photo.jpg');
  } finally {
    await server.close();
  }

  const albumRenameRequests = patchRequests.filter(r =>
    r.url === '/api/albums/album-id-01' && r.body && r.body.albumName !== undefined
  );
  assert.equal(albumRenameRequests.length, 0,
    `Expected no PATCH to rename the album, but got: ${JSON.stringify(albumRenameRequests)}`);
});

test('renaming a symbol-named album folder sends the new user-typed name to Immich, not the sanitized display name', async () => {
  const album = { id: 'album-id-01', albumName: 'Holiday: Summer', description: '', updatedAt: '2024-01-01T00:00:00.000Z' };
  const patchBodies = [];

  const server = await startMockServer((req, res, body) => {
    if (req.method === 'GET' && req.url === '/api/users/me') {
      return json(res, 200, { id: 'user-1', email: 'test@example.com', name: 'test' });
    }
    if (req.method === 'GET' && req.url === '/api/users/me/preferences') {
      return json(res, 200, {});
    }
    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, [album]);
    }
    if (req.method === 'PATCH' && req.url === '/api/albums/album-id-01') {
      patchBodies.push(tryParseJson(body));
      return json(res, 200, {});
    }
    return json(res, 404, { message: 'Not found' });
  });

  try {
    await runRenameAlbum(server.baseUrl, '/albums/Holiday_ Summer', '/albums/Summer 2024');
  } finally {
    await server.close();
  }

  assert.equal(patchBodies.length, 1, `Expected exactly 1 PATCH request, got ${patchBodies.length}: ${JSON.stringify(patchBodies)}`);
  assert.equal(patchBodies[0].albumName, 'Summer 2024',
    `Expected albumName to be 'Summer 2024', got: ${JSON.stringify(patchBodies[0].albumName)}`);
  assert.notEqual(patchBodies[0].albumName, 'Holiday_ Summer',
    'Expected albumName NOT to be the sanitized display name "Holiday_ Summer"');
});

test('changing album.name in album.yaml renames the album on Immich', async () => {
  const album = { id: 'album-id-01', albumName: 'Holiday: Summer', description: '', ownerId: 'user-1', updatedAt: '2024-01-01T00:00:00.000Z' };
  const patchBodies = [];

  const server = await startMockServer((req, res, body) => {
    if (req.method === 'GET' && req.url === '/api/users/me') {
      return json(res, 200, { id: 'user-1', email: 'owner@test.com', name: 'Owner' });
    }
    if (req.method === 'GET' && req.url === '/api/users/me/preferences') {
      return json(res, 200, {});
    }
    if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
      return json(res, 200, [album]);
    }
    if (req.method === 'GET' && req.url === '/api/albums/album-id-01') {
      return json(res, 200, { ...album, assets: [], albumUsers: [] });
    }
    if (req.method === 'PATCH' && req.url === '/api/albums/album-id-01') {
      patchBodies.push(tryParseJson(body));
      return json(res, 200, {});
    }
    return json(res, 404, { message: 'Not found' });
  });

  try {
    await runWriteAlbumYaml(server.baseUrl, '/albums/Holiday_ Summer/album.yaml', 'Summer 2024');
  } finally {
    await server.close();
  }

  const renamePatches = patchBodies.filter(b => b && b.albumName !== undefined);
  assert.equal(renamePatches.length, 1,
    `Expected exactly 1 PATCH with albumName, got ${JSON.stringify(patchBodies)}`);
  assert.equal(renamePatches[0].albumName, 'Summer 2024',
    `Expected albumName to be 'Summer 2024', got: ${JSON.stringify(renamePatches[0].albumName)}`);
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
    env: buildImmichSessionEnv(immichHost),
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
    env: buildImmichSessionEnv(immichHost),
  });
  return JSON.parse(output.stdout);
}

async function runUploadAsset(immichHost, filePath) {
  const script = `
const { ImmichFileSystem } = require(${JSON.stringify(immichFileSystemModulePath)});
const tmp = require('tmp');
const fs = require('fs');
console.log = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.warn = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.error = (...args) => process.stderr.write(args.join(' ') + '\\n');
(async () => {
  const fsBackend = new ImmichFileSystem();
  await fsBackend.login('apikey', 'test-key');
  const tmpFile = tmp.fileSync();
  fs.writeFileSync(tmpFile.name, 'fake image data');
  await fsBackend.writeFile(${JSON.stringify(filePath)}, tmpFile);
  await fsBackend.setAttributes(${JSON.stringify(filePath)}, Math.floor(Date.now() / 1000));
  process.stdout.write('ok');
})().catch((error) => {
  process.stderr.write(String(error) + '\\n');
  process.exit(1);
});
`;

  await execFileAsync(process.execPath, ['-e', script], {
    env: buildImmichSessionEnv(immichHost),
  });
}

async function runRenameAlbum(immichHost, oldPath, newPath) {
  const script = `
const { ImmichFileSystem } = require(${JSON.stringify(immichFileSystemModulePath)});
console.log = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.warn = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.error = (...args) => process.stderr.write(args.join(' ') + '\\n');
(async () => {
  const fsBackend = new ImmichFileSystem();
  await fsBackend.login('apikey', 'test-key');
  await fsBackend.rename(${JSON.stringify(oldPath)}, ${JSON.stringify(newPath)});
  process.stdout.write('ok');
})().catch((error) => {
  process.stderr.write(String(error) + '\\n');
  process.exit(1);
});
`;

  await execFileAsync(process.execPath, ['-e', script], {
    env: buildImmichSessionEnv(immichHost),
  });
}

async function runWriteAlbumYaml(immichHost, filePath, newAlbumName) {
  const script = `
const { ImmichFileSystem } = require(${JSON.stringify(immichFileSystemModulePath)});
const YAML = require(${JSON.stringify(yamlModulePath)});
const tmp = require('tmp');
const fs = require('fs');
console.log = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.warn = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.error = (...args) => process.stderr.write(args.join(' ') + '\\n');
(async () => {
  const fsBackend = new ImmichFileSystem();
  await fsBackend.login('apikey', 'test-key');
  // Read the current album.yaml to get all field values (including dynamic ones like links.immichWeb)
  const currentTmpFile = await fsBackend.readFile(${JSON.stringify(filePath)});
  const currentContent = fs.readFileSync(currentTmpFile.name, 'utf8');
  currentTmpFile.removeCallback();
  // Parse, change only album.name, reserialize
  const doc = YAML.parse(currentContent);
  doc.album.name = ${JSON.stringify(newAlbumName)};
  const newContent = YAML.stringify(doc);
  // Write the modified yaml back
  const newTmpFile = tmp.fileSync();
  fs.writeFileSync(newTmpFile.name, newContent);
  await fsBackend.writeFile(${JSON.stringify(filePath)}, newTmpFile);
  process.stdout.write('ok');
})().catch((error) => {
  process.stderr.write(String(error) + '\\n');
  process.exit(1);
});
`;

  await execFileAsync(process.execPath, ['-e', script], {
    env: buildImmichSessionEnv(immichHost),
  });
}

function startMockServer(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      handler(req, res, body);
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

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}
