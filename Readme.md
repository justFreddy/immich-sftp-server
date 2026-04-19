# Immich SFTP/FTP Server

An **SFTP/FTP “bridge” for Immich**: browse your Immich albums like folders and upload/download photos & videos with an SFTP or FTP client.

## Ideas to use this 💡

- Two-way synchronize your Immich library with your phone (recommended app: FolderSync)
- Import your existing folder-based library as Immich albums
- Synchronize or connect Immich with any file-based third-party system
- Maybe for backups? (Important and recommended: Do proper backups of the whole Immich instance — see https://docs.immich.app/administration/backup-and-restore/)


## Motivation & background 

I’m a Nextcloud user for many years and I’m really happy with it. I have always synchronized my photos and videos with the FolderSync app for Android, which is a very reliable solution, even for large libraries (400 GB+). But no matter what you do, Nextcloud will never get a media management system as good as Immich. At the same time, Immich is still lacking a good two-way synchronization.  

That’s why I came up with this solution. It allows me to reliably sync thousands and tens of thousands of media files with Immich and get reliable reports in the sync app.
It also allows me to do most of the photo sorting on the phone, which is then reflected in Immich. And if I do some sorting on the computer in Immich, it will be reflected back to the phone.

## Important technical facts 

- All actions in this project are **100% based on the official Immich API**. No access to or messing around with Immich internals.
- **No data or metadata is stored** in this container. So it’s not relevant for your backups, and you can stop using it at any point without data loss.

---

## How it works (Immich ↔ SFTP/FTP mapping) ⚙️

### Albums → folders

- Root (`/`) lists the albums the user has in Immich.
- Creating a new folder in SFTP/FTP will create a new album in Immich.
- Add `#nosync` somewhere into an album description in Immich to hide it from SFTP/FTP.

### Assets → files

Inside an album folder, files represent assets. Every asset you have added to an album will be shown inside its SFTP folder.

The file list you see is completely built from the metadata stored in Immich:

- **Filename:** configurable (original name, UUID-based, or date-based)
- **Modified time:** from Immich server asset timestamps
- **Size:** file size of the asset

### Album metadata files

Each album folder also contains:

- `album.yaml`: album settings + metadata (id, owner, shared users/roles, links, etc.)
- `immich.html`: HTML redirect file to open the album in Immich in a browser

`album.yaml` is validated against `schemas/album.yaml.schema.json`.
If a user edits fields they are not allowed to change, save is blocked and an error is returned to the SFTP client.

### Uploads 

Uploading files to SFTP is handled by the following rules:

- Files can only be uploaded into album folders, not into the root folder.
- Upload a **new file**
  - → a **new asset** is created in Immich and **added to that album**
- Upload a file that **already exists** in Immich
  -  → it is **deduplicated** (no duplicate created) and **added to that album**
- Upload a file that was **previously deleted** and is still in the trash
  -  → the asset is **restored from trash** and **added to that album**

### Deleting 

Delete items from your SFTP/FTP client:

- **Delete a file**:
  - if the asset is **only in this album** → it is moved to the **Immich trash**
  - if the asset is also in **other albums** → it is **removed from this album only**
- **Delete an album folder** → the **album is deleted** in Immich  
  > ⚠️ Important: Your SFTP client usually deletes all files inside a folder as well, so assets are also removed according to the rules above. If you could prevent the client from doing so, only the album would be removed, but the assets would not go to the trash.

### Downloads 

Any file can be downloaded from SFTP:

- `original` mode: original file as uploaded to Immich
- `preview` mode: generated smaller preview image from Immich

---

## Deployment (Docker Compose) 🐳

You can run both protocols in parallel. SFTP and FTP can be enabled/disabled independently with environment variables.

### Install on the Immich stack (recommended)

```diff
name: immich

services:
  immich-server:
    container_name: immich_server
    [...]

  immich-machine-learning:
    container_name: immich_machine_learning
    [...]
  
  redis:
    container_name: immich_redis
    [...]

  database:
    container_name: immich_postgres
     [...]
  
+ immich-sftp:
+   container_name: immich_sftp
+   image: ghcr.io/demian98/immich-sftp-server:latest 
 +   ports:
 +    - "22832:22" # SFTP
 +    - "22100:21" # FTP
 +    - "30000-30010:30000-30010" # FTP passive data ports (optional, if passive mode is enabled)
 +   environment:
 +     IMMICH_HOST: http://immich-server:2283
 +     TZ: Europe/Berlin
 +     ENABLE_SFTP: "true"
 +     ENABLE_FTP: "false"
 +     ENABLE_SMB: "false"
 +     ENABLE_WEBDAV: "false"
 +     SFTP_PORT: "22"
 +     FTP_PORT: "21"
 +     FTP_PASSIVE_HOST: "your.public.hostname"
 +     FTP_PASSIVE_PORT_MIN: "30000"
 +     FTP_PASSIVE_PORT_MAX: "30010"
 +     LISTEN_HOST: "0.0.0.0"
 +   restart: unless-stopped

volumes:
  [...]

```

### Standalone

```yaml
services:
  immich-sftp:
    container_name: immich_sftp
    image: ghcr.io/demian98/immich-sftp-server:latest 
    ports:
      - "22832:22" # SFTP
      - "22100:21" # FTP
      - "30000-30010:30000-30010" # FTP passive data ports (optional, if passive mode is enabled)
    environment:
      IMMICH_HOST: https://<your-immich-server-fqdn>:<immich-port>
      TZ: <your TZ>
      ENABLE_SFTP: "true"
      ENABLE_FTP: "false"
      ENABLE_SMB: "false"
      ENABLE_WEBDAV: "false"
      SFTP_PORT: "22"
      FTP_PORT: "21"
      FTP_PASSIVE_HOST: "your.public.hostname"
      FTP_PASSIVE_PORT_MIN: "30000"
      FTP_PASSIVE_PORT_MAX: "30010"
      LISTEN_HOST: "0.0.0.0"
    restart: unless-stopped
```

### Environment variables

- `IMMICH_HOST` (**required**) – base URL of your Immich server (for example `http://immich-server:2283`)
- `TZ` (default: `UTC`) – timezone used for metadata timestamps (for example `Europe/Berlin`)
- `ENABLE_SFTP` (default: `true`) – enable/disable SFTP server
- `ENABLE_FTP` (default: `false`) – enable/disable FTP server
- `ENABLE_SMB` (default: `false`) – enable/disable SMB server (currently not implemented)
- `ENABLE_WEBDAV` (default: `false`) – enable/disable WebDAV server (currently not implemented)
- `SFTP_PORT` (default: `22`) – internal SFTP listen port
- `FTP_PORT` (default: `21`) – internal FTP listen port
- `FTP_PASSIVE_HOST` (optional) – hostname or public IP returned to FTP clients for passive mode
- `FTP_PASSIVE_PORT_MIN` / `FTP_PASSIVE_PORT_MAX` (optional) – passive FTP data port range; set both or neither
- `LISTEN_HOST` (default: `0.0.0.0`) – bind address for both servers
- `ASSET_FILENAME_PATTERN` (default: `original`) – one of:
  - `original` → original filename
  - `assetUuid`/`asset_uuid`/`uuid` → full asset UUID + original extension
  - `shortUuid`/`short_uuid` → `img_<first8uuid>` + original extension
  - `date` → `YYYYMMDD_HHMMSSmmm` + original extension
  - `dateUuid`/`date_uuid` → `YYYYMMDD_HHMMSSmmm_<first8uuid>` + original extension
- `ASSET_DOWNLOAD_SOURCE` (default: `original`) – `original` or `preview`
- `SETTINGS_FILE` (default: `./immich-sftp-server.yaml`) – optional YAML settings file path

### Optional YAML settings file (repository/container root)

If `immich-sftp-server.yaml` exists in the working directory, it can define the same asset settings:

```yaml
asset:
  fileNamePattern: short_uuid
  downloadSource: preview
```

Environment variables still take precedence over YAML values.

### Connect / Test it ✅

Use any SFTP client:

- **Host:** your server hostname/IP
- **Port:** `22832` (from the compose example)
- **Username:** your Immich email
- **Password:** your Immich password

Or use an FTP client if FTP is enabled:

- **Host:** your server hostname/IP
- **Port:** `22100` (from the compose example)
- **Username:** your Immich email
- **Password:** your Immich password

---

## Supported clients 

- FolderSync for Android (https://foldersync.io/)
- WinSCP (https://winscp.net/)

> Most likely most clients will just work — I don’t expect issues. But the two above are tested and working ✅

---

## Known limitations 🧩

- **Renaming files is not possible.** The `originalFileName` in Immich metadata can’t be changed. Because of that, it’s impossible to rename a file via SFTP.
- **Albums are not available** on SFTP when:
  - they contain characters that are invalid for a filename
  - the same album name is used multiple times
- If an album contains multiple assets with the **same original filename**, SFTP clients may not handle it well. Technically this is possible in Immich — try to prevent it.
- You can’t create subfolders, because nested albums are not possible in Immich.
