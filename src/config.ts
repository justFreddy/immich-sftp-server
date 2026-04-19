import fs from 'fs';
import YAML from 'yaml';

export type AssetFileNamePattern = 'original' | 'assetUuid' | 'shortUuid' | 'date' | 'dateUuid';
export type AssetDownloadSource = 'original' | 'preview';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function getEnvOrDefault(name: string, defaultValue: string): string {
  const val = process.env[name];
  if (!val) {
    return defaultValue;
  }
  return val;
}

function getOptionalEnv(name: string): string | undefined {
  const val = process.env[name];
  if (!val) {
    return undefined;
  }
  const normalized = val.trim();
  return normalized === '' ? undefined : normalized;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const val = process.env[name];
  if (!val) {
    return defaultValue;
  }

  const normalized = val.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean environment variable ${name}: ${val}`);
}

function getEnvNumber(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val) {
    return defaultValue;
  }

  const parsed = Number(val);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid numeric environment variable ${name}: ${val}. Expected an integer in range 1-65535.`);
  }
  return parsed;
}

function getOptionalEnvNumber(name: string): number | undefined {
  const val = process.env[name];
  if (!val) {
    return undefined;
  }

  const parsed = Number(val);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid numeric environment variable ${name}: ${val}. Expected an integer in range 1-65535.`);
  }
  return parsed;
}

function isRunningInDocker(): boolean {
  // häufigster Indikator
  try {
    if (fs.existsSync("/.dockerenv")) return true;
  } catch {}

  return false;
}

function getOptionalNestedString(source: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = source;
  for (const part of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current !== 'string') {
    return undefined;
  }
  const normalized = current.trim();
  return normalized === '' ? undefined : normalized;
}

function loadYamlSettingsFile(): Record<string, unknown> {
  const settingsFilePath = getEnvOrDefault('SETTINGS_FILE', './immich-sftp-server.yaml');
  if (!fs.existsSync(settingsFilePath)) {
    return {};
  }

  const content = fs.readFileSync(settingsFilePath, 'utf8');
  const parsed = YAML.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid settings file '${settingsFilePath}': expected a YAML object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseAssetFileNamePattern(value: string | undefined, source: string): AssetFileNamePattern | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const byValue: Record<string, AssetFileNamePattern> = {
    original: 'original',
    asset_uuid: 'assetUuid',
    assetuuid: 'assetUuid',
    uuid: 'assetUuid',
    short_uuid: 'shortUuid',
    shortuuid: 'shortUuid',
    date: 'date',
    date_uuid: 'dateUuid',
    dateuuid: 'dateUuid',
  };
  const parsed = byValue[normalized];
  if (!parsed) {
    throw new Error(`Invalid asset file name pattern from ${source}: ${value}. Allowed: original, assetUuid, shortUuid, date, dateUuid.`);
  }
  return parsed;
}

function parseAssetDownloadSource(value: string | undefined, source: string): AssetDownloadSource | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const byValue: Record<string, AssetDownloadSource> = {
    original: 'original',
    preview: 'preview',
    thumbnail: 'preview',
  };
  const parsed = byValue[normalized];
  if (!parsed) {
    throw new Error(`Invalid asset download source from ${source}: ${value}. Allowed: original, preview.`);
  }
  return parsed;
}

export const config = (() => {
  const ftpPassivePortMin = getOptionalEnvNumber('FTP_PASSIVE_PORT_MIN');
  const ftpPassivePortMax = getOptionalEnvNumber('FTP_PASSIVE_PORT_MAX');
  const yamlSettings = loadYamlSettingsFile();

  if ((ftpPassivePortMin == null) !== (ftpPassivePortMax == null)) {
    throw new Error('FTP_PASSIVE_PORT_MIN and FTP_PASSIVE_PORT_MAX must both be set or both be unset.');
  }
  if (ftpPassivePortMin != null && ftpPassivePortMax != null && ftpPassivePortMin > ftpPassivePortMax) {
    throw new Error('FTP_PASSIVE_PORT_MIN must be less than or equal to FTP_PASSIVE_PORT_MAX.');
  }

  // Support both top-level and nested keys to keep settings flexible and backward compatible.
  const yamlFileNamePattern = parseAssetFileNamePattern(
    getOptionalNestedString(yamlSettings, ['assetFileNamePattern']) ?? getOptionalNestedString(yamlSettings, ['asset', 'fileNamePattern']),
    'settings file',
  );
  const yamlDownloadSource = parseAssetDownloadSource(
    getOptionalNestedString(yamlSettings, ['assetDownloadSource']) ?? getOptionalNestedString(yamlSettings, ['asset', 'downloadSource']),
    'settings file',
  );
  const envFileNamePattern = parseAssetFileNamePattern(getOptionalEnv('ASSET_FILENAME_PATTERN'), 'environment variable ASSET_FILENAME_PATTERN');
  const envDownloadSource = parseAssetDownloadSource(getOptionalEnv('ASSET_DOWNLOAD_SOURCE'), 'environment variable ASSET_DOWNLOAD_SOURCE');

  return {
    immichHost: requireEnv('IMMICH_HOST'),
    TZ: getEnvOrDefault('TZ', 'UTC'),
    hostKeyDir: getEnvOrDefault('HOST_KEY_DIR', isRunningInDocker() ? '/data/ssh-host-key' : './data/ssh-host-key'),
    listenHost: getEnvOrDefault('LISTEN_HOST', '0.0.0.0'),
    sftpPort: getEnvNumber('SFTP_PORT', 22),
    ftpPort: getEnvNumber('FTP_PORT', 21),
    ftpPassiveHost: getOptionalEnv('FTP_PASSIVE_HOST'),
    ftpPassivePortMin,
    ftpPassivePortMax,
    enableSftp: getEnvBoolean('ENABLE_SFTP', true),
    enableFtp: getEnvBoolean('ENABLE_FTP', false),
    assetFileNamePattern: envFileNamePattern ?? yamlFileNamePattern ?? 'original',
    assetDownloadSource: envDownloadSource ?? yamlDownloadSource ?? 'original',
  };
})();
