import fs from 'fs';
import path from 'path';
import tmp from 'tmp';
import { Writable } from 'stream';
import FtpSrv, { FileSystem, GeneralError, FtpConnection } from 'ftp-srv';
import { config } from './config';
import { ImmichFileSystem } from './immich-file-system';
import { VirtualFileSystem } from './virtual-file-system';
import { TransferProtocolServer } from './transfer-protocol-server';

interface FtpStat {
  name: string;
  size: number;
  mtime: Date;
  mode: number;
  uid: number;
  gid: number;
  isDirectory: () => boolean;
}

class UploadToVirtualFileSystemStream extends Writable {
  private readonly tmpFile: tmp.FileResult;
  private readonly writeStream: fs.WriteStream;
  private completed = false;

  constructor(private readonly targetPath: string, private readonly fsBackend: VirtualFileSystem) {
    super();
    this.tmpFile = tmp.fileSync();
    this.writeStream = fs.createWriteStream(this.tmpFile.name);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writeStream.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.writeStream.end(async () => {
      try {
        await this.fsBackend.writeFile(this.targetPath, this.tmpFile);
        await this.fsBackend.setAttributes(this.targetPath, Math.floor(Date.now() / 1000));
        this.completed = true;
        callback();
      } catch (error) {
        callback(error as Error);
      }
    });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.writeStream.destroy();
    if (!this.completed) {
      this.tmpFile.removeCallback();
    }
    callback(error);
  }
}

class ImmichFtpFileSystem extends FileSystem {
  private currentDir = '/';

  constructor(connection: FtpConnection, fsBackend: VirtualFileSystem) {
    super(connection, { root: '/', cwd: '/' });
    this.currentDir = '/';
    this.fsBackend = fsBackend;
  }

  private readonly fsBackend: VirtualFileSystem;

  override currentDirectory(): string {
    return this.currentDir;
  }

  override async get(fileName: string): Promise<FtpStat> {
    const resolvedPath = normalizePath(fileName, this.currentDir);
    if (resolvedPath === '/') {
      return this.toDirectoryStat('/', '/');
    }

    const stat = await this.fsBackend.stat(resolvedPath);
    if (!stat) {
      throw new GeneralError(`No such file or directory: ${fileName}`, 550);
    }

    return this.toStat(path.posix.basename(resolvedPath), stat.isDir, stat.size, stat.mtime);
  }

  override async list(requestPath = '.'): Promise<FtpStat[]> {
    const resolvedPath = normalizePath(requestPath, this.currentDir);
    const files = await this.fsBackend.listFiles(resolvedPath);
    return files.map((file) => this.toStat(file.name, file.isDir, file.size, file.mtime));
  }

  override async chdir(requestPath = '.'): Promise<string> {
    const resolvedPath = normalizePath(requestPath, this.currentDir);
    if (resolvedPath !== '/') {
      const stat = await this.fsBackend.stat(resolvedPath);
      if (!stat || !stat.isDir) {
        throw new GeneralError(`Not a valid directory: ${requestPath}`, 550);
      }
    }

    this.currentDir = resolvedPath;
    return this.currentDir;
  }

  override write(fileName: string, { append = false, start = undefined }: { append?: boolean; start?: number } = {}): { stream: Writable; clientPath: string } {
    if (append || start != null) {
      throw new GeneralError('Resume/append uploads are not supported', 550);
    }

    const resolvedPath = normalizePath(fileName, this.currentDir);
    return {
      stream: new UploadToVirtualFileSystemStream(resolvedPath, this.fsBackend),
      clientPath: resolvedPath,
    };
  }

  override async read(fileName: string, { start = undefined }: { start?: number } = {}): Promise<{ stream: fs.ReadStream; clientPath: string }> {
    const resolvedPath = normalizePath(fileName, this.currentDir);
    const tmpFile = await this.fsBackend.readFile(resolvedPath);
    const stream = fs.createReadStream(tmpFile.name, start != null ? { start } : undefined);
    stream.once('close', () => tmpFile.removeCallback());
    stream.once('error', () => tmpFile.removeCallback());
    return {
      stream,
      clientPath: resolvedPath,
    };
  }

  override async delete(filePath: string): Promise<string> {
    const resolvedPath = normalizePath(filePath, this.currentDir);
    await this.fsBackend.remove(resolvedPath);
    return resolvedPath;
  }

  override async mkdir(filePath: string): Promise<string> {
    const resolvedPath = normalizePath(filePath, this.currentDir);
    await this.fsBackend.mkdir(resolvedPath);
    return resolvedPath;
  }

  override async rename(from: string, to: string): Promise<string> {
    const resolvedFrom = normalizePath(from, this.currentDir);
    const resolvedTo = normalizePath(to, this.currentDir);
    await this.fsBackend.rename(resolvedFrom, resolvedTo);
    return resolvedTo;
  }

  private toDirectoryStat(name: string, displayName: string): FtpStat {
    return {
      name: displayName,
      size: 0,
      mtime: new Date(),
      mode: 0o040755,
      uid: 0,
      gid: 0,
      isDirectory: () => true,
    };
  }

  private toStat(name: string, isDir: boolean, size: number, mtimeSeconds: number): FtpStat {
    return {
      name,
      size,
      mtime: new Date(mtimeSeconds * 1000),
      mode: isDir ? 0o040755 : 0o100644,
      uid: 0,
      gid: 0,
      isDirectory: () => isDir,
    };
  }
}

export class FtpProtocolServer implements TransferProtocolServer {
  readonly name = 'ftp';

  private readonly ftpServer = new FtpSrv(buildFtpServerOptions());

  private readonly backendByConnectionId = new Map<string, VirtualFileSystem>();

  constructor() {
    this.ftpServer.on('login', async ({ connection, username, password }, resolve, reject) => {
      try {
        const fsBackend = new ImmichFileSystem();
        await fsBackend.login(username, password);
        this.backendByConnectionId.set(connection.id, fsBackend);
        resolve({ fs: new ImmichFtpFileSystem(connection, fsBackend) });
      } catch (error) {
        reject(new GeneralError('Authentication failed', 530));
      }
    });

    this.ftpServer.on('disconnect', async ({ id }) => {
      const fsBackend = this.backendByConnectionId.get(id);
      if (fsBackend) {
        try {
          await fsBackend.logout();
        } finally {
          this.backendByConnectionId.delete(id);
        }
      }
    });

    this.ftpServer.on('client-error', ({ error }) => {
      console.error('FTP client error:', error);
    });
  }

  async start(): Promise<void> {
    await this.ftpServer.listen();
    console.log(`FTP server listening on ${config.listenHost}:${config.ftpPort}`);
  }
}

type FtpServerOptions = {
  url: string;
  pasv_url?: string;
  pasv_min?: number;
  pasv_max?: number;
};

export function buildFtpServerOptions(): FtpServerOptions {
  const options: FtpServerOptions = {
    url: `ftp://${config.listenHost}:${config.ftpPort}`,
  };

  if (config.ftpPassiveHost) {
    options.pasv_url = config.ftpPassiveHost;
  }
  if (config.ftpPassivePortMin != null && config.ftpPassivePortMax != null) {
    options.pasv_min = config.ftpPassivePortMin;
    options.pasv_max = config.ftpPassivePortMax;
  }

  return options;
}

function normalizePath(inputPath: string, currentDir: string): string {
  const normalized = path.posix.isAbsolute(inputPath)
    ? path.posix.normalize(inputPath)
    : path.posix.normalize(path.posix.join(currentDir, inputPath));

  const absPath = normalized.replace(/^\/+|\/+$/g, '');
  return absPath === '' ? '/' : `/${absPath}`;
}
