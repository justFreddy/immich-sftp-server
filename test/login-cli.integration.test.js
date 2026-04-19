const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const REPO_ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'super-secret-password';
const USERNAMES = ['user@example.com', 'user+mobile@example.com'];

test('FTP and SFTP CLI login accepts email and plus-address usernames', async (t) => {
  if (!commandExists('ftp') || !commandExists('sftp') || !commandExists('sshpass')) {
    t.skip('Requires ftp, sftp and sshpass CLI tools.');
    return;
  }

  const mock = await startMockImmichServer();
  const sftpPort = await getFreePort();
  const ftpPort = await getFreePort();
  const hostKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-sftp-hostkey-'));
  const serverProcess = await startTransferServer(mock.baseUrl, sftpPort, ftpPort, hostKeyDir);

  t.after(async () => {
    if (serverProcess.exitCode == null) {
      serverProcess.kill('SIGTERM');
      await waitForExitOrTimeout(serverProcess, 5_000);
    }
    await mock.close();
    fs.rmSync(hostKeyDir, { recursive: true, force: true });
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

function commandExists(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
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
        if (payload.password !== PASSWORD) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Invalid credentials' }));
          return;
        }

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

      if (req.method === 'GET' && req.url === '/api/albums') {
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

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

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

async function startTransferServer(immichHost, sftpPort, ftpPort, hostKeyDir) {
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
      HOST_KEY_DIR: hostKeyDir,
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
  const script = `open 127.0.0.1 ${port}\nuser ${username} ${password}\nls\nbye\n`;
  await runCommand('ftp', ['-inv'], script, 20_000);
}

async function runSftpLogin(username, password, port) {
  await runCommand(
    'sshpass',
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
      'BatchMode=no',
      '-l',
      username,
      '127.0.0.1',
    ],
    'ls\nbye\n',
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

async function waitForExitOrTimeout(child, timeoutMs) {
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
