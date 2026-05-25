import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { writeFile } from 'node:fs/promises';

const AUTH_DIR = 'auth_info_baileys';
const HTML_FILE = 'qr.html';

async function writePage(body: string) {
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>whatsarr discovery</title>
<style>
  body{background:#111;color:#eee;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
  img{background:#fff;padding:16px;border-radius:8px;max-width:90vw;height:auto}
  h1{font-weight:500;margin:0 0 16px}
  p{opacity:.75;max-width:480px;line-height:1.5}
  pre{background:#222;padding:12px 16px;border-radius:4px;color:#9f9;text-align:left;max-width:90vw;overflow:auto}
</style>
</head><body>${body}</body></html>`;
  await writeFile(HTML_FILE, html, 'utf8');
}

async function start() {
  await writePage('<h1>Starting Baileys&hellip;</h1>');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WA Web v${version.join('.')} (latest: ${isLatest})`);
  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      await writePage(`
        <h1>Scan from the SECONDARY WhatsApp account</h1>
        <p>Phone &rarr; switch to secondary account &rarr; Settings &rarr; Linked Devices &rarr; Link a Device &rarr; scan</p>
        <img src="${dataUrl}" alt="WhatsApp QR">
        <p style="font-size:12px;opacity:.5">QR auto-refreshes every ~20s. Page reloads every 3s.</p>
      `);
      console.log('[' + new Date().toISOString() + '] QR refreshed');
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connection closed. Code:', code, '| Reconnecting:', shouldReconnect);
      await writePage(`<h1>Disconnected (code ${code})</h1><p>${shouldReconnect ? 'Reconnecting&hellip;' : 'Logged out. Restart the script.'}</p>`);
      if (shouldReconnect) start();
      else process.exit(1);
    }

    if (connection === 'open') {
      console.log('Connected as', sock.user?.id);
      console.log('Fetching groups...');

      const groups = await sock.groupFetchAllParticipating();
      const entries = Object.values(groups);

      let groupHtml = '';
      let groupText = '';
      if (entries.length === 0) {
        groupHtml = '<p>No groups found. Make sure the bot number was added to the target groups.</p>';
        groupText = 'No groups found.';
      } else {
        const rows = entries.map(g => `  ${g.id}\n    name:    ${g.subject}\n    members: ${g.participants?.length ?? '?'}`).join('\n\n');
        groupHtml = `<p>Found ${entries.length} group(s):</p><pre>${rows.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre><p>Copy the two target JIDs into <code>.env</code> as <code>ALLOWED_GROUPS=jid1,jid2</code></p>`;
        groupText = `Found ${entries.length} group(s):\n\n${rows}`;
      }

      await writePage(`<h1>Connected as ${sock.user?.id ?? '?'}</h1>${groupHtml}`);
      await writeFile('groups.txt', groupText, 'utf8');
      console.log('\n' + groupText);
      console.log('\nGroups also saved to groups.txt and qr.html');
    }
  });
}

start();
