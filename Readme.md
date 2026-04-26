# Immich Network Storage

Fork of the original Immich SFTP Server project with additional features and ongoing improvements.

**SFTP/FTP/WebDAV bridge for Immich**: browse your Immich albums like folders and upload/download photos & videos using a standard client.

## What you can do

- Browse albums as folders (`/albums/<album>/...`)
- Upload/download assets via SFTP, FTP, or WebDAV
- Create/rename albums by creating/renaming folders
- Optional virtual folders for tags and people (`/tags/`, `/people/`)

## How it works (quick overview)

Root (`/`) exposes:

- `/albums/` — albums you can access
- `/tags/` — assets by tag (optional)
- `/people/` — assets by recognized person (optional)
- `config.yaml` — your user-specific network-storage settings file

### Album folders

- Create `/albums/MyAlbum` → creates an album in Immich
- Rename `/albums/Old` → `/albums/New` → renames the album in Immich
- Add `#nosync` to an album description in Immich to hide it from all network-storage protocols

### Files = assets

Asset listings are built from Immich metadata:

- filename: configurable (original/UUID/date-based)
- mtime: from Immich asset timestamps
- size: from Immich metadata

Each album folder also contains:

- `album.yaml` — album settings + metadata (validated by `schemas/album.yaml.schema.json`)
- `immich.html` — redirect file to open the album in a browser

### Upload / delete behavior

Uploads are only allowed into `/albums/<name>/`:

- new file → new asset + added to that album
- already exists in Immich → deduplicated + added to that album
- previously deleted (in trash) → restored + added to that album

Deletes:

- delete a file
  - only in this album → moved to Immich trash
  - also in other albums → removed from this album only
- delete an album folder → deletes the album in Immich (note: many clients delete contained files too)

Downloads:

- `original` — original upload
- `preview` — generated preview

## Deployment (Docker Compose)

You can run SFTP, FTP, and WebDAV in parallel and enable/disable each via env vars.

```yaml
services:
  immich-network-storage:
    container_name: immich_network_storage
    image: ghcr.io/demian98/immich-sftp-server:latest
    ports:
      - "22832:22" # SFTP
      - "22100:21" # FTP
      - "19000:1900" # WebDAV
      - "30000-30010:30000-30010" # FTP passive ports (optional)
    environment:
      IMMICH_HOST: https://<your-immich-server-fqdn>:<immich-port>
      TZ: <your TZ>
      ENABLE_SFTP: "true"
      ENABLE_FTP: "false"
      ENABLE_WEBDAV: "false"
      SFTP_PORT: "22"
      FTP_PORT: "21"
      WEBDAV_PORT: "1900"
      FTP_PASSIVE_HOST: "your.public.hostname"
      FTP_PASSIVE_PORT_MIN: "30000"
      FTP_PASSIVE_PORT_MAX: "30010"
      LISTEN_HOST: "0.0.0.0"
      SETTINGS_FILE: "/config/immich-network-storage.yaml"
    volumes:
      - ./immich-network-storage-config:/config
    restart: unless-stopped
```

### Key environment variables

| Variable | Default | Description |
|---|---|---|
| `IMMICH_HOST` | *(required)* | Base URL of your Immich server (e.g. `http://immich-server:2283`). |
| `TZ` | `UTC` | Timezone for timestamps. |
| `LISTEN_HOST` | `0.0.0.0` | Bind address. |
| `ENABLE_SFTP` | `true` | Enable SFTP. |
| `ENABLE_FTP` | `false` | Enable FTP. |
| `ENABLE_WEBDAV` | `false` | Enable WebDAV. |
| `FTP_PASSIVE_HOST` | *(unset)* | Host/IP returned to FTP clients in passive mode. |
| `FTP_PASSIVE_PORT_MIN/MAX` | *(unset)* | Passive FTP port range. |
| `ASSET_FILENAME_PATTERN` | `original` | `original`, `uuid`, `short_uuid`, `date`, `date_uuid`, ... |
| `ASSET_DOWNLOAD_SOURCE` | `original` | `original` or `preview` (`thumbnail` alias accepted). |
| `ENABLE_TAGS_FOLDER_DEFAULT` | `true` | Fallback if user preference can’t be read. |
| `ENABLE_PEOPLE_FOLDER_DEFAULT` | `true` | Fallback if user preference can’t be read. |
| `SETTINGS_FILE` | `./immich-network-storage.yaml` | Optional YAML settings (supports `{userId}`). |

### Optional YAML settings

If `immich-network-storage.yaml` exists in the working directory:

```yaml
asset:
  fileNamePattern: short_uuid
  downloadSource: preview
virtualFolders:
  tags:
    enabledDefault: true
  people:
    enabledDefault: true
```

Env vars still take precedence. Per-user settings are supported via the Immich user ID (UUID) from `users/me`.
On login, a per-user settings file is auto-created in storage (if missing) with merged defaults from environment/code, and is exposed as `/config.yaml` in SFTP/FTP/WebDAV.

## Connect / test

SFTP (example above):

- Host: your server hostname/IP
- Port: `22832`
- Login:
  - email/password (Immich credentials), or
  - API key: user `apikey`, password = your Immich API key

FTP:

- Host: your server hostname/IP
- Port: `22100`
- Login: same as SFTP

WebDAV:

- URL: `http://your-server-hostname:19000`
- Login: same as SFTP

## Known limitations

- Renaming files is not possible (Immich `originalFileName` can’t be changed).
- Albums are exposed under `/albums/` (older clients using the previous root layout must update).
- If an album contains multiple assets with the same original filename, some clients may not handle it well.
- You can’t create subfolders inside an album (nested albums aren’t possible in Immich).
- Album names with invalid filesystem characters are **sanitized** (characters may be replaced with `_`) rather than being hidden.
