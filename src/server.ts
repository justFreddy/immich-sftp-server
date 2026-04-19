import { config } from './config';
import { FtpProtocolServer } from './ftp-server';
import { SftpProtocolServer } from './sftp-server';
import { TransferProtocolServer } from './transfer-protocol-server';

async function startServers(): Promise<void> {
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
}

startServers().catch((error) => {
  console.error('Failed to start transfer servers:', error);
  process.exit(1);
});
