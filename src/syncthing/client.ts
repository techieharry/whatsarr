import { config } from '../config.ts';
import { log } from '../log.ts';

// Reconstructed 2026-05-25 from the .env contract after the original was lost
// to an accidental `robocopy /MIR`. Pre-loss API surface is unknown — this
// scaffold matches the documented Syncthing REST endpoints needed for a future
// !sync command (folder completion to the remote Plex box).
//
// Treats syncthing as disabled when SYNCTHING_URL or SYNCTHING_API_KEY is
// empty — callers should check `isConfigured()` before invoking endpoints.

const log_ = log.child({ mod: 'syncthing' });

const REQUEST_TIMEOUT_MS = 5_000;

export type Completion = {
  /** 0..100 — proportion of the folder this remote device has in sync. */
  completion: number;
  /** Bytes that still need to flow to reach 100%. */
  needBytes: number;
  /** Items (files+dirs) still pending. */
  needItems: number;
  /** Deletes still pending. */
  needDeletes: number;
  /** Total bytes in the folder according to the global index. */
  globalBytes: number;
  /** Last index sequence the remote has acknowledged. */
  sequence?: number;
  /** Remote's reported state for this folder, when available. */
  remoteState?: string;
};

export type FolderStatus = {
  state: string;
  stateChanged: string;
  globalBytes: number;
  globalFiles: number;
  inSyncBytes: number;
  inSyncFiles: number;
  needBytes: number;
  needFiles: number;
  needDeletes: number;
  errors: number;
};

export function isConfigured(): boolean {
  return !!config.syncthing.url && !!config.syncthing.apiKey;
}

async function call(path: string): Promise<any> {
  if (!isConfigured()) throw new Error('syncthing not configured (SYNCTHING_URL / SYNCTHING_API_KEY)');
  const url = `${config.syncthing.url}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'X-API-Key': config.syncthing.apiKey,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      log_.error({ path, status: res.status, body: body.slice(0, 200) }, 'syncthing error');
      throw new Error(`Syncthing GET ${path} -> ${res.status}: ${body.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? res.json() : res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How far along the remote device is in pulling this folder.
 * Defaults to the configured folderId + remoteDeviceId from .env so callers
 * with a single folder/remote setup can just call `getCompletion()`.
 */
export async function getCompletion(
  folderId: string = config.syncthing.folderId,
  deviceId: string = config.syncthing.remoteDeviceId,
): Promise<Completion> {
  if (!folderId) throw new Error('folderId required (or set SYNCTHING_FOLDER_ID)');
  if (!deviceId) throw new Error('deviceId required (or set SYNCTHING_REMOTE_DEVICE_ID)');
  const j = await call(`/rest/db/completion?folder=${encodeURIComponent(folderId)}&device=${encodeURIComponent(deviceId)}`);
  return {
    completion: Number(j.completion ?? 0),
    needBytes: Number(j.needBytes ?? 0),
    needItems: Number(j.needItems ?? 0),
    needDeletes: Number(j.needDeletes ?? 0),
    globalBytes: Number(j.globalBytes ?? 0),
    sequence: j.sequence != null ? Number(j.sequence) : undefined,
    remoteState: j.remoteState,
  };
}

/** Local Syncthing's view of this folder's overall state. */
export async function getFolderStatus(
  folderId: string = config.syncthing.folderId,
): Promise<FolderStatus> {
  if (!folderId) throw new Error('folderId required (or set SYNCTHING_FOLDER_ID)');
  const j = await call(`/rest/db/status?folder=${encodeURIComponent(folderId)}`);
  return {
    state: String(j.state ?? ''),
    stateChanged: String(j.stateChanged ?? ''),
    globalBytes: Number(j.globalBytes ?? 0),
    globalFiles: Number(j.globalFiles ?? 0),
    inSyncBytes: Number(j.inSyncBytes ?? 0),
    inSyncFiles: Number(j.inSyncFiles ?? 0),
    needBytes: Number(j.needBytes ?? 0),
    needFiles: Number(j.needFiles ?? 0),
    needDeletes: Number(j.needDeletes ?? 0),
    errors: Number(j.errors ?? 0),
  };
}

/** Best-effort health probe; returns false on any failure (network or auth). */
export async function ping(): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    await call('/rest/system/ping');
    return true;
  } catch {
    return false;
  }
}
