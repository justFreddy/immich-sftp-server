const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const REPO_ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'super-secret-password';
const USERNAMES = ['user@example.com', 'user+mobile@example.com'];
const SFTP_QUIT_DELAY_MS = 300;

test('FTP and SFTP CLI login accepts email and plus-address usernames', async (t) => {
  if (!commandExists('ftp') || !commandExists('sftp') || !commandExists('sshpass')) {
    t.skip('Requires ftp, sftp and sshpass CLI tools.');
    return;
  }

  const mock = await startMockImmichServer();
  const sftpPort = await getFreePort();
  const ftpPort = await getFreePort();
  const serverProcess = await startTransferServer(mock.baseUrl, sftpPort, ftpPort);

  t.after(async () => {
    if (serverProcess.exitCode == null) {
      serverProcess.kill('SIGTERM');
      await waitForExitOrTimeout(serverProcess, 5_000);
    }
    await mock.close();
  });

  for (const username of USERNAMES) {
    await runFtpLogin(username, PASSWORD, ftpPort);
    await runSftpLogin(username, PASSWORD, sftpPort);
  }

  assert.deepEqual(mock.loginEmails, [
    USERNAMES[0],
    USERNAMES[0],
    USERNAMES[1],
    USERNAMES[1],
  ]);
});

test('FTP active mode can download album assets', async (t) => {
  if (!commandExists('ftp')) {
    t.skip('Requires ftp CLI tool.');
    return;
  }

  const mock = await startMockImmichServerWithAsset();
  const sftpPort = await getFreePort();
  const ftpPort = await getFreePort();
  const serverProcess = await startTransferServer(mock.baseUrl, sftpPort, ftpPort);
  const outputPath = path.join(osTmpDir(), `immich-ns-active-download-${process.pid}.txt`);

  t.after(async () => {
    try {
      fs.rmSync(outputPath, { force: true });
    } catch {}
    if (serverProcess.exitCode == null) {
      serverProcess.kill('SIGTERM');
      await waitForExitOrTimeout(serverProcess, 5_000);
    }
    await mock.close();
  });

  const script = `open 127.0.0.1 ${ftpPort}\nuser ${USERNAMES[0]} ${PASSWORD}\npassive\nbinary\ncd albums/Test\nget x.txt ${outputPath}\nbye\n`;
  await runCommand('ftp', ['-inv'], script, 20_000);

  assert.equal(fs.existsSync(outputPath), true);
  const content = fs.readFileSync(outputPath, 'utf8');
  assert.equal(content, 'hello world');
});

function commandExists(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = getListeningPort(server.address());
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startMockImmichServer() {
  const loginEmails = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = body ? JSON.parse(body) : {};

      if (req.method === 'POST' && req.url === '/api/auth/login') {
        loginEmails.push(String(payload.email ?? ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          accessToken: 'mock-access-token',
          user: {
            id: 'mock-user-id',
            email: payload.email,
            username: payload.email,
          },
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/auth/logout') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = getListeningPort(server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    loginEmails,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function startMockImmichServerWithAsset() {
  const loginEmails = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = body ? JSON.parse(body) : {};

      if (req.method === 'POST' && req.url === '/api/auth/login') {
        loginEmails.push(String(payload.email ?? ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          accessToken: 'mock-access-token',
          user: {
            id: 'mock-user-id',
            email: payload.email,
            username: payload.email,
          },
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/auth/logout') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      if (req.method === 'GET' && req.url === '/api/users/me/preferences') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      if (req.method === 'GET' && (req.url === '/api/albums' || req.url === '/api/albums?shared=true')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'album-1', albumName: 'Test', description: '' }]));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/albums/album-1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'album-1',
          albumName: 'Test',
          description: '',
          assets: [{
            id: 'asset-1',
            originalFileName: 'x.txt',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            fileCreatedAt: '2025-01-01T00:00:00.000Z',
            fileModifiedAt: '2025-01-01T00:00:00.000Z',
            isTrashed: false,
            exifInfo: { fileSizeInByte: 11 },
          }],
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/assets/asset-1/original') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('hello world');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = getListeningPort(server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    loginEmails,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function osTmpDir() {
  return require('node:os').tmpdir();
}

async function startTransferServer(immichHost, sftpPort, ftpPort) {
  const child = spawn('node', ['dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      IMMICH_HOST: immichHost,
      TZ: 'UTC',
      ENABLE_SFTP: 'true',
      ENABLE_FTP: 'true',
      SFTP_PORT: String(sftpPort),
      FTP_PORT: String(ftpPort),
      LISTEN_HOST: '127.0.0.1',
      SETTINGS_FILE: path.join('/tmp', `immich-ns-cli-login-${process.pid}.yaml`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForOutput(child, 'Enabled protocols: sftp, ftp', 20_000);
  return child;
}

function waitForOutput(child, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onData = (chunk) => {
      output += chunk.toString('utf8');
      if (output.includes(needle)) {
        finish();
      }
    };

    const onExit = (code, signal) => {
      finish(new Error(`Server exited before ready (code=${code}, signal=${signal}). Output:\n${output}`));
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for server output "${needle}". Output:\n${output}`));
    }, timeoutMs);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

async function runFtpLogin(username, password, port) {
  const script = `open 127.0.0.1 ${port}\nuser ${username} ${password}\nbye\n`;
  await runCommand('ftp', ['-inv'], script, 20_000);
}

async function runSftpLogin(username, password, port) {
  await waitForSftpConnection(
    [
      '-p',
      password,
      'sftp',
      '-P',
      String(port),
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'PreferredAuthentications=password',
      '-o',
      'PasswordAuthentication=yes',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      `User=${username}`,
      '127.0.0.1',
    ],
    20_000,
  );
}

function runCommand(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onStdout = (chunk) => {
      stdout += chunk.toString('utf8');
    };

    const onStderr = (chunk) => {
      stderr += chunk.toString('utf8');
    };

    const onExit = (code, signal) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`${command} ${args.join(' ')} failed (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`${command} timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);

    child.stdin.end(input);
  });
}

function waitForSftpConnection(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('sshpass', args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let connected = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onStdout = (chunk) => {
      stdout += chunk.toString('utf8');
    };

    const onStderr = (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.includes('Permission denied')) {
        finish(new Error(`SFTP login failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }

      if (!connected && stderr.includes('Connected to ')) {
        connected = true;
        child.stdin.write('quit\n');
        setTimeout(() => {
          if (child.exitCode == null) {
            child.kill('SIGTERM');
          }
          finish();
        }, SFTP_QUIT_DELAY_MS);
      }
    };

    const onExit = (code, signal) => {
      if (!connected && code !== 0) {
        finish(new Error(`SFTP process exited before connection (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    };

    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGTERM');
      }
      finish(new Error(`SFTP command timed out after ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

async function waitForExitOrTimeout(child, timeoutMs) {
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function getListeningPort(address) {
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine listening port.');
  }
  return address.port;
}
