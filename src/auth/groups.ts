import { config } from '../config.ts';

export function isAllowedGroup(groupJid: string): boolean {
  return config.whatsapp.allowedGroups.includes(groupJid);
}

export function isAdmin(senderNumber: string): boolean {
  const normalized = senderNumber.replace(/^\+/, '');
  return config.whatsapp.adminNumbers.includes(normalized);
}

export function jidToNumber(jid: string): string {
  // '15555550100@s.whatsapp.net' or '15555550100:1@s.whatsapp.net' -> '15555550100'
  const m = jid.match(/^(\d+)/);
  return m ? m[1]! : '';
}
