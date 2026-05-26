import type { Store } from '../state/store.ts';
import { log } from '../log.ts';

const log_ = log.child({ mod: 'commands' });

export type CommandDeps = {
  store: Store;
  seerr: typeof import('../seerr/client.ts');
  send: (to: string, content: { text: string; mentions?: string[] }) => Promise<unknown>;
  drainPending: () => Promise<void>;
  reconnectWa: () => Promise<void>;
  shutdown: () => void;
};

export const COMMAND_NAMES = ['reconnect_wa', 'vacuum_db', 'drain_pending', 'send_test_dm', 'shutdown'] as const;
export type CommandName = typeof COMMAND_NAMES[number];

export function isCommandName(s: string): s is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(s);
}

export async function runCommand(
  id: number,
  name: CommandName,
  args: Record<string, unknown> | undefined,
  deps: CommandDeps,
): Promise<'succeeded' | 'failed'> {
  deps.store.markCommandRunning(id);
  log_.info({ id, name }, 'command running');
  try {
    switch (name) {
      case 'reconnect_wa': {
        await deps.reconnectWa();
        deps.store.completeCommand(id, 'reconnect triggered');
        log_.info({ id, name }, 'command succeeded');
        return 'succeeded';
      }
      case 'vacuum_db': {
        deps.store.vacuum();
        deps.store.completeCommand(id, 'db vacuumed');
        log_.info({ id, name }, 'command succeeded');
        return 'succeeded';
      }
      case 'drain_pending': {
        await deps.drainPending();
        deps.store.completeCommand(id, 'pending drain triggered');
        log_.info({ id, name }, 'command succeeded');
        return 'succeeded';
      }
      case 'send_test_dm': {
        const to = typeof args?.to === 'string' ? args.to.trim() : '';
        const text = typeof args?.text === 'string' ? args.text : '';
        if (!to || !text) throw new Error('send_test_dm requires non-empty {to, text}');
        await deps.send(to, { text });
        deps.store.completeCommand(id, `sent to ${to}`);
        log_.info({ id, name, to }, 'command succeeded');
        return 'succeeded';
      }
      case 'shutdown': {
        // Mark complete before exiting; process will terminate inside deps.shutdown().
        deps.store.completeCommand(id, 'shutting down');
        log_.info({ id, name }, 'command succeeded; invoking shutdown');
        deps.shutdown();
        return 'succeeded';
      }
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    deps.store.failCommand(id, msg);
    log_.warn({ id, name, err: msg }, 'command failed');
    return 'failed';
  }
}
