import 'dotenv/config';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}
function optional(key: string, def: string): string {
  return process.env[key] ?? def;
}
function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${key}="${v}" is not an integer`);
  return n;
}

function normalizeNumber(s: string): string {
  return s.trim().replace(/^\+/, '').replace(/[\s-]/g, '');
}

export const config = {
  seerr: {
    url: required('SEERR_URL').replace(/\/$/, ''),
    apiKey: required('SEERR_API_KEY'),
    defaultUserId: num('SEERR_DEFAULT_USER_ID', 1),
    webhookSecret: optional('SEERR_WEBHOOK_SECRET', ''),
  },
  whatsapp: {
    allowedGroups: required('ALLOWED_GROUPS').split(',').map(s => s.trim()).filter(Boolean),
    adminNumbers: optional('ADMIN_NUMBERS', '').split(',').map(normalizeNumber).filter(Boolean),
    commandPrefix: optional('COMMAND_PREFIX', '!'),
  },
  limits: {
    requestsPerDay: num('REQUESTS_PER_DAY', 5),
    dedupWindowHours: num('DEDUP_WINDOW_HOURS', 1),
    confirmTtlMinutes: num('CONFIRM_TTL_MINUTES', 10),
  },
  webhook: {
    enabled: optional('WEBHOOK_ENABLED', 'true') === 'true',
    port: num('WEBHOOK_PORT', 5056),
    bind: optional('WEBHOOK_BIND', '127.0.0.1'),
  },
  storage: {
    dbPath: optional('DB_PATH', 'data/whatsarr.sqlite'),
    authDir: optional('AUTH_DIR', 'auth_info_baileys'),
  },
  logLevel: optional('LOG_LEVEL', 'info'),
  // Optional: !sync command surfaces Syncthing's per-folder completion to a
  // remote device (a Plex box on the other end of the link). All vars are
  // optional; if url/apiKey are empty, src/syncthing/client.ts treats syncthing
  // as disabled.
  syncthing: {
    url: optional('SYNCTHING_URL', '').replace(/\/$/, ''),
    apiKey: optional('SYNCTHING_API_KEY', ''),
    folderId: optional('SYNCTHING_FOLDER_ID', ''),
    folders: optional('SYNCTHING_FOLDERS', '').split(',').map(s => s.trim()).filter(Boolean),
    remoteDeviceId: optional('SYNCTHING_REMOTE_DEVICE_ID', ''),
    remoteLabel: optional('SYNCTHING_REMOTE_LABEL', 'remote'),
  },
  dashboard: {
    token: optional('DASHBOARD_TOKEN', ''),
  },
};

export type Config = typeof config;
