import type { TransferProtocolServer } from './transfer-protocol-server';

async function startServers(): Promise<void> {
  try {
    const [{ config }, { FtpProtocolServer }, { SftpProtocolServer }] = await Promise.all([
      import('./config'),
      import('./ftp-server'),
      import('./sftp-server'),
    ]);
    const servers: TransferProtocolServer[] = [];

    if (config.enableSftp) {
      servers.push(new SftpProtocolServer());
    }
    if (config.enableFtp) {
      servers.push(new FtpProtocolServer());
    }

    if (servers.length === 0) {
      throw new Error('No transfer protocol enabled. Set ENABLE_SFTP and/or ENABLE_FTP (accepted values: true/1/yes/on or false/0/no/off).');
    }

    await Promise.all(servers.map((server) => server.start()));
    console.log(`Enabled protocols: ${servers.map((server) => server.name).join(', ')}`);
  } catch (error) {
    console.error('Failed to initialize or start transfer servers:', error);
    process.exit(1);
  }
}

startServers().catch((error) => {
  console.error('Unhandled startup error:', error);
  process.exit(1);
});
