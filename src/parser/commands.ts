export type MediaTypeHint = 'movie' | 'tv' | 'ambiguous';

export type Category =
  | 'western'
  | 'bollywood'
  | 'pakistani'
  | 'foreign'
  | 'documentary'
  | 'asian'
  | 'anime'
  | 'animated';

export type ParsedCommand =
  | { kind: 'request'; mediaTypeHint: MediaTypeHint; category: Category | null; title: string }
  | { kind: 'status' }
  | { kind: 'queue' }
  | { kind: 'help' }
  | { kind: 'sync' }
  | { kind: 'feedback'; body: string }
  | { kind: 'issue'; body: string }
  | { kind: 'incomplete'; cmd: string; reason: string }
  | { kind: 'unknown'; reason: string };

const CATEGORY_ALIASES: Record<string, Category> = {
  western: 'western',
  bollywood: 'bollywood', bolly: 'bollywood', hindi: 'bollywood',
  pakistani: 'pakistani', pak: 'pakistani', urdu: 'pakistani',
  foreign: 'foreign', intl: 'foreign',
  documentary: 'documentary', doc: 'documentary', docu: 'documentary',
  asian: 'asian', kdrama: 'asian', cdrama: 'asian', jdrama: 'asian',
  anime: 'anime',
  animated: 'animated', cartoon: 'animated',
};

const MOVIE_CMDS = new Set(['movie', 'film']);
const TV_CMDS = new Set(['tv', 'show', 'series']);
const REQ_CMDS = new Set(['req', 'request']);

export function parse(input: string, prefix = '!'): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith(prefix)) {
    return { kind: 'unknown', reason: 'no prefix' };
  }

  const tokens = trimmed.slice(prefix.length).trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') {
    return { kind: 'unknown', reason: 'empty command' };
  }

  const cmd = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === 'status') return { kind: 'status' };
  if (cmd === 'queue' || cmd === 'mine') return { kind: 'queue' };
  if (cmd === 'help') return { kind: 'help' };
  if (cmd === 'sync' || cmd === 'syncstatus') return { kind: 'sync' };
  if (cmd === 'feedback' || cmd === 'fb') {
    const body = rest.join(' ').trim();
    if (!body) return { kind: 'incomplete', cmd: 'feedback', reason: 'feedback needs a message' };
    return { kind: 'feedback', body };
  }
  if (cmd === 'issue' || cmd === 'bug' || cmd === 'report') {
    const body = rest.join(' ').trim();
    if (!body) return { kind: 'incomplete', cmd: 'issue', reason: 'issue needs a description' };
    return { kind: 'issue', body };
  }

  let mediaTypeHint: MediaTypeHint;
  if (MOVIE_CMDS.has(cmd)) mediaTypeHint = 'movie';
  else if (TV_CMDS.has(cmd)) mediaTypeHint = 'tv';
  else if (REQ_CMDS.has(cmd)) mediaTypeHint = 'ambiguous';
  else return { kind: 'unknown', reason: `unknown command: ${cmd}` };

  if (rest.length === 0) {
    return { kind: 'incomplete', cmd, reason: `${cmd} needs a title` };
  }

  const maybeCat = rest[0]!.toLowerCase();
  const category = CATEGORY_ALIASES[maybeCat] ?? null;
  const title = (category ? rest.slice(1) : rest).join(' ').trim();

  if (!title) {
    return { kind: 'incomplete', cmd, reason: `${cmd} ${maybeCat} needs a title` };
  }

  return { kind: 'request', mediaTypeHint, category, title };
}
