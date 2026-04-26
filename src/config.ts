import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export type AssetFileNamePattern = 'original' | 'assetUuid' | 'shortUuid' | 'date' | 'dateUuid';
export type AssetDownloadSource = 'original' | 'preview';
export type UserScopedSettings = {
  assetFileNamePattern: AssetFileNamePattern;
  assetDownloadSource: AssetDownloadSource;
  enableTagsFolderDefault: boolean;
  enablePeopleFolderDefault: boolean;
};

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

function getOptionalNestedBoolean(source: Record<string, unknown>, path: string[]): boolean | undefined {
  let current: unknown = source;
  for (const part of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current === 'boolean') {
    return current;
  }
  if (typeof current !== 'string') {
    return undefined;
  }

  const normalized = current.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function buildPerUserSettingsFilePath(settingsFilePath: string, userId: string): string {
  const parsed = path.parse(settingsFilePath);
  const fileName = `${parsed.name}.${userId}${parsed.ext}`;
  return parsed.dir ? path.join(parsed.dir, fileName) : fileName;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SETTINGS_FILE = './immich-network-storage.yaml';

function isUuid(value?: string): value is string {
  return !!value && UUID_PATTERN.test(value);
}

function getConfiguredSettingsFilePath(): string {
  return getEnvOrDefault('SETTINGS_FILE', DEFAULT_SETTINGS_FILE);
}

function parseYamlSettingsObject(content: string, sourceLabel: string): Record<string, unknown> {
  const parsed = YAML.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid settings file '${sourceLabel}': expected a YAML object.`);
  }
  return parsed as Record<string, unknown>;
}

function getUserScopedSettingsTargetPath(settingsFilePath: string, userId?: string): string {
  const normalizedUserId = userId?.trim();
  if (isUuid(normalizedUserId)) {
    if (settingsFilePath.includes('{userId}')) {
      return settingsFilePath.replace(/\{userId\}/g, normalizedUserId);
    }
    return buildPerUserSettingsFilePath(settingsFilePath, normalizedUserId);
  }
  return settingsFilePath;
}

function parseUserScopedSettingsOverrides(yamlSettings: Record<string, unknown>): Partial<UserScopedSettings> {
  return {
    assetFileNamePattern: parseAssetFileNamePattern(
      getOptionalNestedString(yamlSettings, ['assetFileNamePattern']) ?? getOptionalNestedString(yamlSettings, ['asset', 'fileNamePattern']),
      'settings file',
    ),
    assetDownloadSource: parseAssetDownloadSource(
      getOptionalNestedString(yamlSettings, ['assetDownloadSource']) ?? getOptionalNestedString(yamlSettings, ['asset', 'downloadSource']),
      'settings file',
    ),
    enableTagsFolderDefault: getOptionalNestedBoolean(yamlSettings, ['virtualFolders', 'tags', 'enabledDefault']),
    enablePeopleFolderDefault: getOptionalNestedBoolean(yamlSettings, ['virtualFolders', 'people', 'enabledDefault']),
  };
}

function resolveSettingsFilePath(userId?: string): string | undefined {
  const settingsFilePath = getConfiguredSettingsFilePath();
  const candidates: string[] = [];
  const normalizedUserId = userId?.trim();
  if (isUuid(normalizedUserId)) {
    candidates.push(getUserScopedSettingsTargetPath(settingsFilePath, normalizedUserId));
    candidates.push(buildPerUserSettingsFilePath(settingsFilePath, normalizedUserId));
  }
  candidates.push(settingsFilePath);

  for (const candidatePath of new Set(candidates)) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}

function loadYamlSettingsFile(userId?: string): Record<string, unknown> {
  const settingsFilePath = resolveSettingsFilePath(userId);
  if (!settingsFilePath) {
    return {};
  }

  const content = fs.readFileSync(settingsFilePath, 'utf8');
  return parseYamlSettingsObject(content, settingsFilePath);
}

function readYamlSettingOverrides(userId?: string): Partial<UserScopedSettings> {
  return parseUserScopedSettingsOverrides(loadYamlSettingsFile(userId));
}

export function loadSettingsForUser(userId?: string): UserScopedSettings {
  const yamlOverrides = readYamlSettingOverrides(userId);
  return {
    assetFileNamePattern: yamlOverrides.assetFileNamePattern ?? config.assetFileNamePattern,
    assetDownloadSource: yamlOverrides.assetDownloadSource ?? config.assetDownloadSource,
    enableTagsFolderDefault: yamlOverrides.enableTagsFolderDefault ?? config.enableTagsFolderDefault,
    enablePeopleFolderDefault: yamlOverrides.enablePeopleFolderDefault ?? config.enablePeopleFolderDefault,
  };
}

function buildSettingsFileContent(settings: UserScopedSettings): string {
  return YAML.stringify({
    asset: {
      fileNamePattern: settings.assetFileNamePattern,
      downloadSource: settings.assetDownloadSource,
    },
    virtualFolders: {
      tags: {
        enabledDefault: settings.enableTagsFolderDefault,
      },
      people: {
        enabledDefault: settings.enablePeopleFolderDefault,
      },
    },
  });
}

export function getSettingsFilePathForUser(userId?: string): string {
  return getUserScopedSettingsTargetPath(getConfiguredSettingsFilePath(), userId?.trim());
}

export function ensureSettingsFileForUser(userId?: string): string {
  const targetPath = getSettingsFilePathForUser(userId);
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  const initialSettings = loadSettingsForUser(userId);
  const parentDir = path.dirname(targetPath);
  if (parentDir && parentDir !== '.') {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(targetPath, buildSettingsFileContent(initialSettings), 'utf8');
  return targetPath;
}

export function parseAndMergeUserSettingsContent(content: string, userId?: string): UserScopedSettings {
  const parsed = parseYamlSettingsObject(content, 'uploaded settings content');
  const overrides = parseUserScopedSettingsOverrides(parsed);
  const current = loadSettingsForUser(userId);
  return {
    assetFileNamePattern: overrides.assetFileNamePattern ?? current.assetFileNamePattern,
    assetDownloadSource: overrides.assetDownloadSource ?? current.assetDownloadSource,
    enableTagsFolderDefault: overrides.enableTagsFolderDefault ?? current.enableTagsFolderDefault,
    enablePeopleFolderDefault: overrides.enablePeopleFolderDefault ?? current.enablePeopleFolderDefault,
  };
}

export function saveSettingsForUser(userId: string | undefined, settings: UserScopedSettings): string {
  const targetPath = getSettingsFilePathForUser(userId);
  const parentDir = path.dirname(targetPath);
  if (parentDir && parentDir !== '.') {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(targetPath, buildSettingsFileContent(settings), 'utf8');
  return targetPath;
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
  const yamlOverrides = readYamlSettingOverrides();

  if ((ftpPassivePortMin == null) !== (ftpPassivePortMax == null)) {
    throw new Error('FTP_PASSIVE_PORT_MIN and FTP_PASSIVE_PORT_MAX must both be set or both be unset.');
  }
  if (ftpPassivePortMin != null && ftpPassivePortMax != null && ftpPassivePortMin > ftpPassivePortMax) {
    throw new Error('FTP_PASSIVE_PORT_MIN must be less than or equal to FTP_PASSIVE_PORT_MAX.');
  }

  const envFileNamePattern = parseAssetFileNamePattern(getOptionalEnv('ASSET_FILENAME_PATTERN'), 'environment variable ASSET_FILENAME_PATTERN');
  const envDownloadSource = parseAssetDownloadSource(getOptionalEnv('ASSET_DOWNLOAD_SOURCE'), 'environment variable ASSET_DOWNLOAD_SOURCE');

  return {
    immichHost: requireEnv('IMMICH_HOST'),
    TZ: getEnvOrDefault('TZ', 'UTC'),
    listenHost: getEnvOrDefault('LISTEN_HOST', '0.0.0.0'),
    sftpPort: getEnvNumber('SFTP_PORT', 22),
    ftpPort: getEnvNumber('FTP_PORT', 21),
    ftpPassiveHost: getOptionalEnv('FTP_PASSIVE_HOST'),
    ftpPassivePortMin,
    ftpPassivePortMax,
    enableSftp: getEnvBoolean('ENABLE_SFTP', true),
    enableFtp: getEnvBoolean('ENABLE_FTP', false),
    enableWebdav: getEnvBoolean('ENABLE_WEBDAV', false),
    webdavPort: getEnvNumber('WEBDAV_PORT', 1900),
    assetFileNamePattern: envFileNamePattern ?? yamlOverrides.assetFileNamePattern ?? 'original',
    assetDownloadSource: envDownloadSource ?? yamlOverrides.assetDownloadSource ?? 'original',
    enableTagsFolderDefault: getEnvBoolean('ENABLE_TAGS_FOLDER_DEFAULT', yamlOverrides.enableTagsFolderDefault ?? true),
    enablePeopleFolderDefault: getEnvBoolean('ENABLE_PEOPLE_FOLDER_DEFAULT', yamlOverrides.enablePeopleFolderDefault ?? true),
  };
})();
