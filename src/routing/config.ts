import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Category } from '../parser/commands.ts';

export type MediaType = 'movie' | 'tv';

export type Route = {
  rootFolder: string;
  profileId: number;
  profileName: string;
};

export type RoutingConfig = {
  movies: Partial<Record<Category, Route>>;
  tv: Partial<Record<Category, Route>>;
  // Optional defense-in-depth guard: any resolved rootFolder matching this
  // pattern is refused (e.g. a curated / off-limits library that must never
  // receive automated requests). null = no guard configured.
  forbiddenPath: RegExp | null;
};

export type ResolveResult =
  | { ok: true; mediaType: MediaType; category: Category; route: Route }
  | { ok: false; reason: string };

// routing.config.json holds your deployment-specific routes (library root
// folders + Sonarr/Radarr quality-profile ids). It is gitignored — keep your
// real paths out of source. routing.config.example.json (committed) is the
// placeholder fallback so a fresh clone, the test suite, and `npm run demo`
// still boot before you have configured your own.
const repoRoot = new URL('../../', import.meta.url);
const REAL_PATH = fileURLToPath(new URL('routing.config.json', repoRoot));
const EXAMPLE_PATH = fileURLToPath(new URL('routing.config.example.json', repoRoot));

function parseRouteMap(raw: unknown, where: string): Partial<Record<Category, Route>> {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `routing config: "${where}" must be an object mapping category -> { rootFolder, profileId, profileName }`,
    );
  }
  const out: Partial<Record<Category, Route>> = {};
  for (const [cat, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') {
      throw new Error(`routing config: ${where}.${cat} must be an object`);
    }
    const e = v as Record<string, unknown>;
    const rootFolder = typeof e.rootFolder === 'string' ? e.rootFolder.trim() : '';
    if (!rootFolder) {
      throw new Error(`routing config: ${where}.${cat}.rootFolder is required (non-empty string)`);
    }
    if (typeof e.profileId !== 'number' || !Number.isInteger(e.profileId)) {
      throw new Error(
        `routing config: ${where}.${cat}.profileId must be an integer (the Sonarr/Radarr quality-profile id)`,
      );
    }
    const profileName = typeof e.profileName === 'string' ? e.profileName.trim() : '';
    if (!profileName) {
      throw new Error(`routing config: ${where}.${cat}.profileName is required (non-empty string)`);
    }
    out[cat as Category] = { rootFolder, profileId: e.profileId, profileName };
  }
  return out;
}

// Parse + validate an already-JSON-parsed routing config. Exported so tests can
// exercise validation without touching disk.
export function parseRoutingConfig(raw: unknown, source = 'routing config'): RoutingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: top level must be a JSON object`);
  }
  const r = raw as Record<string, unknown>;
  const movies = parseRouteMap(r.movies, 'movies');
  const tv = parseRouteMap(r.tv, 'tv');
  if (Object.keys(movies).length === 0 && Object.keys(tv).length === 0) {
    throw new Error(`${source}: at least one route under "movies" or "tv" is required`);
  }
  let forbiddenPath: RegExp | null = null;
  if (r.forbiddenPath != null && String(r.forbiddenPath).trim() !== '') {
    try {
      forbiddenPath = new RegExp(String(r.forbiddenPath));
    } catch (e: any) {
      throw new Error(`${source}: forbiddenPath is not a valid regular expression: ${e?.message ?? e}`);
    }
  }
  return { movies, tv, forbiddenPath };
}

// Load the routing config from disk. Prefers routing.config.json (your real,
// gitignored, per-deployment routes); falls back to routing.config.example.json
// (committed placeholders) with a loud warning so a fresh clone still boots.
export function loadRoutingConfig(): RoutingConfig {
  let path: string;
  let usingExample = false;
  if (existsSync(REAL_PATH)) {
    path = REAL_PATH;
  } else if (existsSync(EXAMPLE_PATH)) {
    path = EXAMPLE_PATH;
    usingExample = true;
  } else {
    throw new Error(
      'No routing config found. Copy routing.config.example.json to routing.config.json and edit it for ' +
        'your library (root folders + Sonarr/Radarr profile ids).',
    );
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e: any) {
    throw new Error(`routing config: could not read ${path}: ${e?.message ?? e}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`routing config ${path} is not valid JSON: ${e?.message ?? e}`);
  }
  const cfg = parseRoutingConfig(raw, `routing config (${path})`);
  if (usingExample) {
    console.warn(
      '⚠ routing.config.json not found — using routing.config.example.json (placeholder routes). ' +
        'Copy it to routing.config.json and edit it for your library before serving real requests.',
    );
  }
  return cfg;
}

// Pure resolver: takes an explicit config so it is trivially testable and free
// of disk/global state. table.ts wraps this around the loaded ambient config.
export function resolveRouteWith(
  cfg: RoutingConfig,
  mediaType: MediaType,
  category: Category | null,
): ResolveResult {
  const cat: Category = category ?? 'western';
  const table = mediaType === 'movie' ? cfg.movies : cfg.tv;
  const route = table[cat];
  if (!route) {
    return { ok: false, reason: `category "${cat}" not valid for ${mediaType}` };
  }
  if (cfg.forbiddenPath && cfg.forbiddenPath.test(route.rootFolder)) {
    throw new Error(
      `routing refused: ${mediaType}/${cat} maps to forbidden path "${route.rootFolder}"`,
    );
  }
  return { ok: true, mediaType, category: cat, route };
}
