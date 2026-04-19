import fs from 'fs';

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

function isRunningInDocker(): boolean {
  // häufigster Indikator
  try {
    if (fs.existsSync("/.dockerenv")) return true;
  } catch {}

  return false;
}

export const config = {
  immichHost: requireEnv('IMMICH_HOST'),
  TZ: getEnvOrDefault('TZ', 'UTC'),
  hostKeyDir: getEnvOrDefault('HOST_KEY_DIR', isRunningInDocker() ? '/data/ssh-host-key' : './data/ssh-host-key'),
  listenHost: getEnvOrDefault('LISTEN_HOST', '0.0.0.0'),
  sftpPort: getEnvNumber('SFTP_PORT', 22),
  ftpPort: getEnvNumber('FTP_PORT', 21),
  enableSftp: getEnvBoolean('ENABLE_SFTP', true),
  enableFtp: getEnvBoolean('ENABLE_FTP', false),
};
