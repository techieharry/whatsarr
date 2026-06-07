import type { Category } from '../parser/commands.ts';
import {
  loadRoutingConfig,
  resolveRouteWith,
  type MediaType,
  type Route,
  type ResolveResult,
} from './config.ts';

export type { MediaType, Route, ResolveResult };

// Routes are loaded once at startup from routing.config.json (placeholder
// fallback: routing.config.example.json). Deployment-specific library paths +
// Sonarr/Radarr profile ids live in that gitignored config — edit it, not this
// file. See src/routing/config.ts and ROUTING.md.
const ROUTING = loadRoutingConfig();

export const MOVIE_ROUTES = ROUTING.movies;
export const TV_ROUTES = ROUTING.tv;
// Configured forbidden-path guard (null if unset). Defense in depth: a resolved
// rootFolder matching this is refused even if a config edit adds it. See
// ROUTING.md "Never routed to".
export const FORBIDDEN_PATH = ROUTING.forbiddenPath;

export function resolveRoute(mediaType: MediaType, category: Category | null): ResolveResult {
  return resolveRouteWith(ROUTING, mediaType, category);
}
