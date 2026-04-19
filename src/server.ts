import type { TransferProtocolServer } from './transfer-protocol-server';

async function startServers(): Promise<void> {
  const [{ config }, { FtpProtocolServer }, { SftpProtocolServer }] = await Promise.all([
    import('./config'),
    import('./ftp-server'),
    import('./sftp-server'),
  ]);
  const servers: TransferProtocolServer[] = [];

  if (config.enableSmb) {
    throw new Error('SMB is not implemented yet. Set ENABLE_SMB to false.');
  }
  if (config.enableWebdav) {
    throw new Error('WebDAV is not implemented yet. Set ENABLE_WEBDAV to false.');
  }

  if (config.enableSftp) {
    servers.push(new SftpProtocolServer());
  }
  if (config.enableFtp) {
    servers.push(new FtpProtocolServer());
  }

  if (servers.length === 0) {
    throw new Error('No transfer protocol enabled. Set ENABLE_SFTP and/or ENABLE_FTP (accepted values: true/1/yes/on or false/0/no/off). ENABLE_SMB and ENABLE_WEBDAV are available but currently not implemented.');
  }

  await Promise.all(servers.map((server) => server.start()));
  console.log(`Enabled protocols: ${servers.map((server) => server.name).join(', ')}`);
}

startServers().catch((error) => {
  console.error('Failed to initialize or start transfer servers:', error);
  process.exit(1);
});
