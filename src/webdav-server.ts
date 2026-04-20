import fs from 'fs';
import tmp from 'tmp';
import crypto from 'crypto';
import { Writable, Readable } from 'stream';
import { v2 as webdav } from 'webdav-server';
import { config } from './config';
import { ImmichFileSystem } from './immich-file-system';
import { VirtualFileSystem } from './virtual-file-system';
import { TransferProtocolServer } from './transfer-protocol-server';

// ──────────────────────────────────────────────────────────────
// Auth: custom user manager that validates against Immich
// ──────────────────────────────────────────────────────────────

interface ImmichWebdavUser extends webdav.IUser {
  readonly fsBackend: VirtualFileSystem;
}

interface CachedUser {
  readonly user: ImmichWebdavUser;
  // Stored for timing-safe comparison on subsequent requests (not used for
  // persistent storage – the session lives only in process memory).
  readonly passwordBuf: Buffer;
  lastUsed: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

// Cache keyed by username.  The stored passwordBuf is compared in
// constant-time on every cache hit to guard against session hijacking.
const userCache = new Map<string, CachedUser>();

function pruneUserCache(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, entry] of userCache) {
    if (entry.lastUsed < cutoff) {
      entry.user.fsBackend.logout().catch(() => {});
      userCache.delete(key);
    }
  }
}

setInterval(pruneUserCache, 5 * 60 * 1000).unref();

/** Call a webdav-server success callback.  The library's TS types declare the
 *  first argument as `Error` (never null/undefined), but the runtime checks
 *  truthiness; `undefined!` is the standard non-null-assertion way to satisfy
 *  the compiler while passing the falsy sentinel that the library expects. */
function cbOk<T>(callback: (err: Error, value?: T) => void, value: T): void {
  callback(undefined!, value);
}

class ImmichWebdavUserManager implements webdav.ITestableUserManager {
  getDefaultUser(callback: (user: webdav.IUser) => void): void {
    callback({ uid: 'default', username: 'anonymous', isDefaultUser: true });
  }

  getUserByNamePassword(
    username: string,
    password: string,
    callback: (error: Error, user?: webdav.IUser) => void,
  ): void {
    const passwordBuf = Buffer.from(password, 'utf8');
    const cached = userCache.get(username);

    if (cached) {
      const storedBuf = cached.passwordBuf;
      const match =
        storedBuf.length === passwordBuf.length &&
        crypto.timingSafeEqual(storedBuf, passwordBuf);

      if (match) {
        cached.lastUsed = Date.now();
        cbOk(callback, cached.user);
        return;
      }

      // Different password for the same username → evict stale session.
      cached.user.fsBackend.logout().catch(() => {});
      userCache.delete(username);
    }

    const fsBackend = new ImmichFileSystem();
    fsBackend
      .login(username, password)
      .then(() => {
        const user: ImmichWebdavUser = { uid: username, username, fsBackend };
        userCache.set(username, { user, passwordBuf, lastUsed: Date.now() });
        cbOk(callback, user);
      })
      .catch(() => {
        callback(new Error('Authentication failed'));
      });
  }
}

// ──────────────────────────────────────────────────────────────
// Write stream: buffer to tmp file, then commit via VirtualFileSystem
// ──────────────────────────────────────────────────────────────

class WebdavUploadStream extends Writable {
  private readonly tmpFile = tmp.fileSync();
  private readonly writeStream: fs.WriteStream;
  private completed = false;

  constructor(
    private readonly targetPath: string,
    private readonly fsBackend: VirtualFileSystem,
  ) {
    super();
    this.writeStream = fs.createWriteStream(this.tmpFile.name);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writeStream.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.writeStream.end(async () => {
      try {
        await this.fsBackend.writeFile(this.targetPath, this.tmpFile);
        await this.fsBackend.setAttributes(
          this.targetPath,
          Math.floor(Date.now() / 1000),
        );
        this.completed = true;
        callback();
      } catch (err) {
        callback(err as Error);
      }
    });
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.writeStream.destroy();
    if (!this.completed) {
      this.tmpFile.removeCallback();
    }
    callback(error);
  }
}

// ──────────────────────────────────────────────────────────────
// Serializer (no persistence needed)
// ──────────────────────────────────────────────────────────────

class NoopSerializer implements webdav.FileSystemSerializer {
  uid(): string {
    return 'ImmichWebdavSerializer_1.0.0';
  }
  serialize(
    _fs: webdav.FileSystem,
    callback: webdav.ReturnCallback<unknown>,
  ): void {
    callback(undefined, {});
  }
  unserialize(
    _data: unknown,
    callback: webdav.ReturnCallback<webdav.FileSystem>,
  ): void {
    callback(undefined, new ImmichWebdavFileSystem());
  }
}

// ──────────────────────────────────────────────────────────────
// FileSystem: bridge between webdav-server and VirtualFileSystem
// ──────────────────────────────────────────────────────────────

// Lock and property managers are shared across users because WebDAV locks are
// server-scoped (identified by tokens), not user-scoped.
const lockManagers = new Map<string, webdav.LocalLockManager>();
const propManagers = new Map<string, webdav.LocalPropertyManager>();

function getLockManager(key: string): webdav.LocalLockManager {
  let m = lockManagers.get(key);
  if (!m) {
    m = new webdav.LocalLockManager();
    lockManagers.set(key, m);
  }
  return m;
}

function getPropManager(key: string): webdav.LocalPropertyManager {
  let m = propManagers.get(key);
  if (!m) {
    m = new webdav.LocalPropertyManager();
    propManagers.set(key, m);
  }
  return m;
}

function getBackend(ctx: webdav.IContextInfo): VirtualFileSystem | null {
  const user = ctx.context.user as ImmichWebdavUser | undefined;
  return user?.fsBackend ?? null;
}

class ImmichWebdavFileSystem extends webdav.FileSystem {
  constructor() {
    super(new NoopSerializer());
    this.doNotSerialize();
  }

  // ── abstract required ──────────────────────────────────────

  protected _lockManager(
    path: webdav.Path,
    _ctx: webdav.LockManagerInfo,
    callback: webdav.ReturnCallback<webdav.ILockManager>,
  ): void {
    callback(undefined, getLockManager(path.toString()));
  }

  protected _propertyManager(
    path: webdav.Path,
    _ctx: webdav.PropertyManagerInfo,
    callback: webdav.ReturnCallback<webdav.IPropertyManager>,
  ): void {
    callback(undefined, getPropManager(path.toString()));
  }

  protected _type(
    path: webdav.Path,
    ctx: webdav.TypeInfo,
    callback: webdav.ReturnCallback<webdav.ResourceType>,
  ): void {
    if (path.isRoot()) {
      callback(undefined, webdav.ResourceType.Directory);
      return;
    }
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    backend
      .stat(path.toString())
      .then((stat) => {
        if (!stat) {
          callback(webdav.Errors.ResourceNotFound);
          return;
        }
        callback(
          undefined,
          stat.isDir ? webdav.ResourceType.Directory : webdav.ResourceType.File,
        );
      })
      .catch((err) => callback(err));
  }

  // ── directory listing ──────────────────────────────────────

  protected _readDir(
    path: webdav.Path,
    ctx: webdav.ReadDirInfo,
    callback: webdav.ReturnCallback<string[] | webdav.Path[]>,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    backend
      .listFiles(path.toString())
      .then((files) => callback(undefined, files.map((f) => f.name)))
      .catch((err) => callback(err));
  }

  // ── file metadata ──────────────────────────────────────────

  protected _size(
    path: webdav.Path,
    ctx: webdav.SizeInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    backend
      .stat(path.toString())
      .then((stat) => {
        if (!stat) {
          callback(webdav.Errors.ResourceNotFound);
          return;
        }
        callback(undefined, stat.size);
      })
      .catch((err) => callback(err));
  }

  protected _lastModifiedDate(
    path: webdav.Path,
    ctx: webdav.LastModifiedDateInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    backend
      .stat(path.toString())
      .then((stat) => {
        if (!stat) {
          callback(webdav.Errors.ResourceNotFound);
          return;
        }
        callback(undefined, stat.mtime * 1000);
      })
      .catch((err) => callback(err));
  }

  protected _creationDate(
    path: webdav.Path,
    ctx: webdav.CreationDateInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    // Immich doesn't separate creation date from modification date at this
    // level; delegate to _lastModifiedDate for a reasonable approximation.
    this._lastModifiedDate(
      path,
      ctx as unknown as webdav.LastModifiedDateInfo,
      callback,
    );
  }

  // ── read / write ──────────────────────────────────────────

  protected _openReadStream(
    path: webdav.Path,
    ctx: webdav.OpenReadStreamInfo,
    callback: webdav.ReturnCallback<Readable>,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    backend
      .readFile(path.toString())
      .then((tmpFile) => {
        const stream = fs.createReadStream(tmpFile.name);
        stream.once('close', () => tmpFile.removeCallback());
        stream.once('error', () => tmpFile.removeCallback());
        callback(undefined, stream);
      })
      .catch((err) => callback(err));
  }

  protected _openWriteStream(
    path: webdav.Path,
    ctx: webdav.OpenWriteStreamInfo,
    callback: webdav.ReturnCallback<Writable>,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    callback(undefined, new WebdavUploadStream(path.toString(), backend));
  }

  // ── create / delete / rename / move ──────────────────────

  protected _create(
    path: webdav.Path,
    ctx: webdav.CreateInfo,
    callback: webdav.SimpleCallback,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    if (ctx.type.isDirectory) {
      backend
        .mkdir(path.toString())
        .then(() => callback())
        .catch((err) => callback(err));
    } else {
      // File creation is handled by the subsequent _openWriteStream call.
      callback();
    }
  }

  protected _delete(
    path: webdav.Path,
    ctx: webdav.DeleteInfo,
    callback: webdav.SimpleCallback,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    backend
      .remove(path.toString())
      .then(() => callback())
      .catch((err) => callback(err));
  }

  protected _rename(
    pathFrom: webdav.Path,
    newName: string,
    ctx: webdav.RenameInfo,
    callback: webdav.ReturnCallback<boolean>,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    const pathTo = pathFrom.getParent().getChildPath(newName);
    backend
      .rename(pathFrom.toString(), pathTo.toString())
      .then(() => callback(undefined, true))
      .catch((err) => callback(err));
  }

  protected _move(
    pathFrom: webdav.Path,
    pathTo: webdav.Path,
    ctx: webdav.MoveInfo,
    callback: webdav.ReturnCallback<boolean>,
  ): void {
    const backend = getBackend(ctx);
    if (!backend) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    backend
      .rename(pathFrom.toString(), pathTo.toString())
      .then(() => callback(undefined, true))
      .catch((err) => callback(err));
  }
}

// ──────────────────────────────────────────────────────────────
// Protocol server
// ──────────────────────────────────────────────────────────────

export class WebdavProtocolServer implements TransferProtocolServer {
  readonly name = 'webdav';

  private readonly server = new webdav.WebDAVServer({
    port: config.webdavPort,
    hostname: config.listenHost,
    requireAuthentification: true,
    httpAuthentication: new webdav.HTTPBasicAuthentication(
      new ImmichWebdavUserManager(),
      'Immich WebDAV',
    ),
    rootFileSystem: new ImmichWebdavFileSystem(),
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.start((httpServer) => {
        if (!httpServer) {
          reject(new Error('WebDAV server failed to start'));
          return;
        }
        console.log(
          `WebDAV server listening on ${config.listenHost}:${config.webdavPort}`,
        );
        resolve();
      });
    });
  }
}
