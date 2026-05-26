export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<meta name="color-scheme" content="dark light" />
<title>whatsarr</title>
<link rel="stylesheet" href="/dashboard/app.css" />
</head>
<body>
<header class="topbar">
  <div class="brand">whatsarr</div>
  <nav class="tabs" role="tablist">
    <a class="tab" data-tab="overview"  href="#overview">overview</a>
    <a class="tab" data-tab="requests"  href="#requests">requests</a>
    <a class="tab" data-tab="pending"   href="#pending">pending</a>
    <a class="tab" data-tab="syncthing" href="#syncthing">syncthing</a>
    <a class="tab" data-tab="feedback"  href="#feedback">feedback</a>
  </nav>
  <div class="status">
    <span id="conn-dot" class="dot dot-unknown" title="connection"></span>
    <span id="uptime" class="uptime">—</span>
    <span id="counters" class="counters"></span>
  </div>
</header>

<main>
  <section id="panel-overview" class="panel" hidden>
    <div class="overview-grid">
      <div class="card">
        <h2>validation</h2>
        <div class="scroll-x"><table id="validation-table" class="data"><thead><tr><th>check</th><th>status</th><th>detail</th></tr></thead><tbody></tbody></table></div>
      </div>
      <div class="card">
        <h2>24h</h2>
        <ul class="kv">
          <li><span>total</span><b id="ov-total">—</b></li>
          <li><span>queued</span><b id="ov-queued">—</b></li>
          <li><span>failed</span><b id="ov-failed">—</b></li>
          <li><span>pending notifications</span><b id="ov-pending">—</b></li>
        </ul>
      </div>
    </div>
    <div class="card">
      <h2>recent errors</h2>
      <pre id="recent-errors" class="mono tail"></pre>
    </div>
  </section>

  <section id="panel-requests" class="panel" hidden>
    <div class="filterbar">
      <label>status
        <select id="f-status">
          <option value="">any</option>
          <option value="queued">queued</option>
          <option value="failed">failed</option>
          <option value="succeeded">succeeded</option>
        </select>
      </label>
      <label>sender
        <input id="f-user" type="text" placeholder="number or jid" />
      </label>
      <label>group
        <select id="f-group"><option value="">any</option></select>
      </label>
      <label class="check"><input id="f-since" type="checkbox" /> last 24h</label>
      <span class="grow"></span>
      <span id="req-meta" class="meta">—</span>
    </div>
    <div class="scroll-x">
      <table id="requests-table" class="data clickable">
        <thead><tr><th>ts</th><th>user</th><th>command</th><th>status</th><th>route</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="pager">
      <button id="req-prev" type="button">&#9664; prev</button>
      <span id="req-page" class="meta">page 1</span>
      <button id="req-next" type="button">next &#9654;</button>
    </div>
  </section>

  <section id="panel-pending" class="panel" hidden>
    <div class="scroll-x">
      <table id="pending-table" class="data">
        <thead><tr><th>id</th><th>target</th><th>text</th><th>attempts</th><th>last error</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <p id="pending-meta" class="meta">—</p>
  </section>

  <section id="panel-syncthing" class="panel" hidden>
    <div id="syncthing-body"></div>
  </section>

  <section id="panel-feedback" class="panel" hidden>
    <nav class="subtabs">
      <a class="subtab" data-kind="feedback" href="#feedback">feedback</a>
      <a class="subtab" data-kind="issue" href="#feedback/issue">issue</a>
    </nav>
    <div class="scroll-x">
      <table id="feedback-table" class="data">
        <thead><tr><th>ts</th><th>sender</th><th>body</th><th>report</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>
</main>

<div id="drawer" class="drawer" hidden>
  <div class="drawer-backdrop"></div>
  <aside class="drawer-body">
    <button id="drawer-close" class="drawer-close" type="button">close</button>
    <h2>row detail</h2>
    <pre id="drawer-json" class="mono"></pre>
  </aside>
</div>

<div id="auth-banner" class="banner" hidden>token expired, re-bookmark <code>?token=…</code></div>

__WHATSARR_BOOTSTRAP__
<script src="/dashboard/app.js"></script>
</body>
</html>
`;

export const APP_JS = String.raw`(function () {
  'use strict';

  var BOOT = window.__WHATSARR__ || { apiBase: '/api', features: {}, pollIntervals: { heartbeat: 1000, active: 5000, static: 30000 } };
  var API = BOOT.apiBase || '/api';
  var POLL = BOOT.pollIntervals || { heartbeat: 1000, active: 5000, static: 30000 };

  var TABS = ['overview', 'requests', 'pending', 'syncthing', 'feedback'];
  var TIER = { overview: 'active', requests: 'active', pending: 'active', syncthing: 'static', feedback: 'static' };
  var authFailed = false;

  var reqState = { limit: 50, offset: 0, status: '', user: '', group: '', since: false, total: 0 };
  var fbState = { kind: 'feedback' };
  var knownGroups = Object.create(null);

  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function el(tag, opts, children) {
    var n = document.createElement(tag);
    if (opts) {
      if (opts.cls) n.className = opts.cls;
      if (opts.text != null) n.textContent = String(opts.text);
      if (opts.attrs) for (var k in opts.attrs) n.setAttribute(k, opts.attrs[k]);
      if (opts.title) n.title = opts.title;
    }
    if (children) for (var i = 0; i < children.length; i++) if (children[i]) n.appendChild(children[i]);
    return n;
  }

  function fetchJson(path) {
    return fetch(API + path, { credentials: 'include', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { authFailed = true; showAuthBanner(); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error('http ' + r.status);
        authFailed = false; hideAuthBanner();
        return r.json();
      });
  }
  function showAuthBanner() { var b = $('auth-banner'); if (b) b.hidden = false; }
  function hideAuthBanner() { var b = $('auth-banner'); if (b) b.hidden = true; }

  function fmtUptime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var parts = [];
    if (d) parts.push(d + 'd');
    if (h || d) parts.push(h + 'h');
    if (m || h || d) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  }
  function fmtRelative(ts) {
    var t = Number(ts);
    if (!Number.isFinite(t)) return '—';
    var diff = Math.floor((Date.now() - t) / 1000);
    if (diff < 0) return 'now';
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }
  function maskTarget(jid) {
    if (!jid) return '';
    var m = String(jid).match(/(\d+)/);
    if (!m) return '••••';
    var n = m[1];
    return '••••' + n.slice(-4);
  }
  function trunc(s, n) {
    s = s == null ? '' : String(s);
    if (s.length <= n) return s;
    return s.slice(0, n) + '…';
  }

  function activeTab() {
    var raw = (location.hash || '#overview').replace(/^#/, '').split('/')[0];
    return TABS.indexOf(raw) >= 0 ? raw : 'overview';
  }
  function showTab(name) {
    for (var i = 0; i < TABS.length; i++) {
      var p = $('panel-' + TABS[i]);
      if (p) p.hidden = TABS[i] !== name;
    }
    var tabs = document.querySelectorAll('.tab');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].classList.toggle('active', tabs[j].getAttribute('data-tab') === name);
    }
    if (name === 'feedback') {
      var sub = (location.hash.split('/')[1] === 'issue') ? 'issue' : 'feedback';
      fbState.kind = sub;
      var stabs = document.querySelectorAll('.subtab');
      for (var k = 0; k < stabs.length; k++) {
        stabs[k].classList.toggle('active', stabs[k].getAttribute('data-kind') === sub);
      }
    }
    refreshActive();
  }

  function renderHeartbeat(hb) {
    var dot = $('conn-dot');
    dot.classList.remove('dot-ok', 'dot-bad', 'dot-unknown');
    dot.classList.add(hb.connected ? 'dot-ok' : 'dot-bad');
    dot.title = hb.connected ? 'baileys connected' : 'baileys disconnected';
    $('uptime').textContent = fmtUptime(hb.uptimeSec);
    $('counters').textContent = 'pending ' + (hb.pendingCount || 0) + ' • retries ' + (hb.retryCount || 0);
  }

  function renderOverview(o) {
    var d = o.diagnosis || {};
    var v = d.validation || { checks: [] };
    var a = d.audit || {};
    var tbody = $('validation-table').querySelector('tbody');
    clear(tbody);
    var checks = v.checks || [];
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      var status = el('span', { cls: 'badge ' + (c.ok ? 'b-ok' : 'b-fail'), text: c.ok ? 'pass' : 'fail' });
      tbody.appendChild(el('tr', null, [
        el('td', { text: c.name || '' }),
        el('td', null, [status]),
        el('td', { text: c.detail || '' })
      ]));
    }
    $('ov-total').textContent = a.totalLast24h != null ? a.totalLast24h : '—';
    $('ov-queued').textContent = a.queuedLast24h != null ? a.queuedLast24h : '—';
    $('ov-failed').textContent = a.failedLast24h != null ? a.failedLast24h : '—';
    $('ov-pending').textContent = d.pendingNotifications != null ? d.pendingNotifications : '—';
    var errs = (d.recentErrors || []).slice(-15);
    $('recent-errors').textContent = errs.length ? errs.join('\n') : '(no recent errors)';
  }

  function renderRequests(payload) {
    var rows = payload.rows || [];
    reqState.total = payload.total || 0;
    var tbody = $('requests-table').querySelector('tbody');
    clear(tbody);
    var groupSel = $('f-group');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.groupJid && !knownGroups[r.groupJid]) {
        knownGroups[r.groupJid] = true;
        groupSel.appendChild(el('option', { text: r.groupJid, attrs: { value: r.groupJid } }));
      }
      var tr = el('tr');
      tr.appendChild(el('td', { text: fmtRelative(r.ts) }));
      tr.appendChild(el('td', { text: r.senderNumber || r.senderJid || '' }));
      tr.appendChild(el('td', { text: r.command || '' }));
      tr.appendChild(el('td', null, [el('span', { cls: 'badge b-' + (r.status || 'unknown'), text: r.status || '' })]));
      tr.appendChild(el('td', { text: r.resolvedRoute || (r.seerrMediaType ? r.seerrMediaType + '/' + (r.seerrMediaId || '') : '') }));
      tr.dataset.row = JSON.stringify(r);
      tr.addEventListener('click', onRowClick);
      tbody.appendChild(tr);
    }
    var page = Math.floor(reqState.offset / reqState.limit) + 1;
    var pages = Math.max(1, Math.ceil(reqState.total / reqState.limit));
    $('req-page').textContent = 'page ' + page + ' / ' + pages;
    $('req-meta').textContent = reqState.total + ' total';
    $('req-prev').disabled = reqState.offset <= 0;
    $('req-next').disabled = reqState.offset + reqState.limit >= reqState.total;
  }

  function onRowClick(ev) {
    var tr = ev.currentTarget;
    var row = JSON.parse(tr.dataset.row || '{}');
    $('drawer-json').textContent = JSON.stringify(row, null, 2);
    $('drawer').hidden = false;
  }

  function renderPending(payload) {
    var rows = payload.rows || [];
    var tbody = $('pending-table').querySelector('tbody');
    clear(tbody);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var errCell = el('td', { text: r.lastError ? trunc(r.lastError, 40) : '', title: r.lastError || '' });
      tbody.appendChild(el('tr', null, [
        el('td', { text: r.id }),
        el('td', { text: maskTarget(r.targetJid) }),
        el('td', { text: trunc(r.text || '', 80) }),
        el('td', { text: r.attempts }),
        errCell
      ]));
    }
    $('pending-meta').textContent = (payload.total || rows.length) + ' pending';
  }

  function renderSyncthing(s) {
    var body = $('syncthing-body');
    clear(body);
    if (!s || !s.configured) {
      body.appendChild(el('div', { cls: 'card grey', text: 'Syncthing not configured.' }));
      return;
    }
    var folders = s.folders || [];
    if (!folders.length) {
      body.appendChild(el('div', { cls: 'card grey', text: 'No folders reported.' }));
      return;
    }
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      var st = f.status || {};
      var pct = Math.max(0, Math.min(100, Math.floor(Number(f.completion) || 0)));
      var bars = Math.round(pct / 10);
      var bar = '';
      for (var b = 0; b < 10; b++) bar += b < bars ? '█' : '░';
      var card = el('div', { cls: 'card folder' });
      card.appendChild(el('h3', { text: f.id || 'folder' }));
      card.appendChild(el('span', { cls: 'badge b-' + (st.state || 'unknown'), text: st.state || 'unknown' }));
      card.appendChild(el('div', { cls: 'mono progress', text: bar + '  ' + pct + '%' }));
      var need = (st.needBytes || 0) + ' bytes • ' + (st.needFiles || 0) + ' files remaining';
      card.appendChild(el('div', { cls: 'meta', text: need }));
      body.appendChild(card);
    }
  }

  function renderFeedback(payload) {
    var rows = payload.rows || [];
    var tbody = $('feedback-table').querySelector('tbody');
    clear(tbody);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var bodyTd = el('td');
      var bodyTxt = String(r.body || '');
      var short = el('span', { cls: 'fb-body', text: trunc(bodyTxt, 100) });
      if (bodyTxt.length > 100) {
        short.style.cursor = 'pointer';
        short.title = 'click to expand';
        short.addEventListener('click', (function (full, span) {
          return function () { span.textContent = full; span.style.cursor = ''; };
        })(bodyTxt, short));
      }
      bodyTd.appendChild(short);

      var reportTd = el('td');
      if (r.report) {
        var details = el('details');
        details.appendChild(el('summary', { text: 'report' }));
        details.appendChild(el('pre', { cls: 'mono', text: r.report }));
        reportTd.appendChild(details);
      }
      tbody.appendChild(el('tr', null, [
        el('td', { text: fmtRelative(r.ts) }),
        el('td', { text: r.senderNumber || r.senderJid || '' }),
        bodyTd,
        reportTd
      ]));
    }
  }

  function pollHeartbeat() {
    fetchJson('/heartbeat').then(renderHeartbeat).catch(function () {
      var dot = $('conn-dot');
      dot.classList.remove('dot-ok'); dot.classList.add('dot-bad');
    });
  }

  function refreshActive() {
    var tab = activeTab();
    if (TIER[tab] !== 'active') { refreshStatic(); return; }
    if (tab === 'overview') fetchJson('/overview').then(renderOverview).catch(noop);
    if (tab === 'requests') fetchRequests();
    if (tab === 'pending') fetchJson('/pending').then(renderPending).catch(noop);
  }
  function refreshStatic() {
    var tab = activeTab();
    if (TIER[tab] !== 'static') return;
    if (tab === 'syncthing') fetchJson('/syncthing').then(renderSyncthing).catch(noop);
    if (tab === 'feedback') fetchJson('/feedback?kind=' + encodeURIComponent(fbState.kind)).then(renderFeedback).catch(noop);
  }
  function noop() {}

  function fetchRequests() {
    var q = [];
    q.push('limit=' + reqState.limit);
    q.push('offset=' + reqState.offset);
    if (reqState.status) q.push('status=' + encodeURIComponent(reqState.status));
    if (reqState.user) q.push('user=' + encodeURIComponent(reqState.user));
    if (reqState.group) q.push('group=' + encodeURIComponent(reqState.group));
    if (reqState.since) q.push('since=' + (Date.now() - 86400000));
    fetchJson('/audit?' + q.join('&')).then(renderRequests).catch(noop);
  }

  function wireFilters() {
    $('f-status').addEventListener('change', function (e) { reqState.status = e.target.value; reqState.offset = 0; fetchRequests(); });
    var userTimer = 0;
    $('f-user').addEventListener('input', function (e) {
      clearTimeout(userTimer);
      var v = e.target.value;
      userTimer = setTimeout(function () { reqState.user = v; reqState.offset = 0; fetchRequests(); }, 300);
    });
    $('f-group').addEventListener('change', function (e) { reqState.group = e.target.value; reqState.offset = 0; fetchRequests(); });
    $('f-since').addEventListener('change', function (e) { reqState.since = !!e.target.checked; reqState.offset = 0; fetchRequests(); });
    $('req-prev').addEventListener('click', function () { reqState.offset = Math.max(0, reqState.offset - reqState.limit); fetchRequests(); });
    $('req-next').addEventListener('click', function () { reqState.offset = reqState.offset + reqState.limit; fetchRequests(); });

    var subtabs = document.querySelectorAll('.subtab');
    for (var i = 0; i < subtabs.length; i++) {
      subtabs[i].addEventListener('click', function (e) {
        e.preventDefault();
        var kind = e.currentTarget.getAttribute('data-kind');
        location.hash = kind === 'issue' ? '#feedback/issue' : '#feedback';
      });
    }

    $('drawer-close').addEventListener('click', function () { $('drawer').hidden = true; });
    document.querySelector('.drawer-backdrop').addEventListener('click', function () { $('drawer').hidden = true; });
  }

  function start() {
    wireFilters();
    window.addEventListener('hashchange', function () { showTab(activeTab()); });
    showTab(activeTab());
    pollHeartbeat();
    refreshActive();
    refreshStatic();
    setInterval(pollHeartbeat, POLL.heartbeat || 1000);
    setInterval(refreshActive, POLL.active || 5000);
    setInterval(refreshStatic, POLL.static || 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

export const APP_CSS = `:root {
  --bg: #0e1116;
  --panel: #161b22;
  --panel-2: #1c232c;
  --border: #2a313c;
  --fg: #e6edf3;
  --fg-dim: #8b949e;
  --accent: #2f81f7;
  --ok: #3fb950;
  --warn: #d29922;
  --bad: #f85149;
  --grey: #6e7681;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f8fa;
    --panel: #ffffff;
    --panel-2: #f0f3f6;
    --border: #d0d7de;
    --fg: #1f2328;
    --fg-dim: #59636e;
    --grey: #afb8c1;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 var(--sans); }
a { color: var(--accent); text-decoration: none; }

.topbar { display: flex; align-items: center; gap: 1rem; padding: .5rem 1rem; border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 5; }
.brand { font-weight: 600; letter-spacing: .03em; }
.tabs { display: flex; gap: .25rem; overflow-x: auto; flex: 1; }
.tab { padding: .35rem .75rem; border-radius: 4px; color: var(--fg-dim); white-space: nowrap; }
.tab:hover { background: var(--panel-2); color: var(--fg); }
.tab.active { background: var(--panel-2); color: var(--fg); border-bottom: 2px solid var(--accent); }
.status { display: flex; align-items: center; gap: .75rem; color: var(--fg-dim); font-family: var(--mono); font-size: 12px; }
.uptime { min-width: 8ch; text-align: right; }
.counters { white-space: nowrap; }

.dot { width: .65rem; height: .65rem; border-radius: 50%; display: inline-block; }
.dot-ok { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.dot-bad { background: var(--bad); box-shadow: 0 0 6px var(--bad); }
.dot-unknown { background: var(--grey); }

main { padding: 1rem; max-width: 1400px; margin: 0 auto; }
.panel { display: flex; flex-direction: column; gap: 1rem; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; }
.card h2, .card h3 { margin: 0 0 .5rem 0; font-size: 14px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .04em; }
.card.grey { color: var(--fg-dim); }

.overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
@media (max-width: 700px) { .overview-grid { grid-template-columns: 1fr; } }

.kv { list-style: none; margin: 0; padding: 0; }
.kv li { display: flex; justify-content: space-between; padding: .35rem 0; border-bottom: 1px dashed var(--border); }
.kv li:last-child { border-bottom: 0; }
.kv b { font-family: var(--mono); }

.scroll-x { overflow-x: auto; }
table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
table.data th, table.data td { padding: .4rem .6rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
table.data th { color: var(--fg-dim); font-weight: 500; background: var(--panel-2); position: sticky; top: 0; }
table.data.clickable tbody tr { cursor: pointer; }
table.data.clickable tbody tr:hover { background: var(--panel-2); }

.badge { display: inline-block; padding: .1rem .4rem; border-radius: 3px; font-size: 12px; font-family: var(--mono); background: var(--panel-2); color: var(--fg-dim); border: 1px solid var(--border); }
.b-ok, .b-succeeded { color: var(--ok); border-color: var(--ok); }
.b-fail, .b-failed { color: var(--bad); border-color: var(--bad); }
.b-queued { color: var(--warn); border-color: var(--warn); }
.b-unknown { color: var(--grey); }

.filterbar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
.filterbar label { display: flex; flex-direction: column; gap: .2rem; font-size: 12px; color: var(--fg-dim); }
.filterbar label.check { flex-direction: row; align-items: center; gap: .35rem; }
.filterbar input, .filterbar select { background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: .3rem .5rem; font: inherit; }
.filterbar .grow { flex: 1; }
.meta { color: var(--fg-dim); font-size: 12px; font-family: var(--mono); }

.pager { display: flex; gap: .5rem; align-items: center; justify-content: flex-end; }
.pager button { background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: .3rem .6rem; cursor: pointer; }
.pager button:disabled { color: var(--fg-dim); cursor: not-allowed; opacity: .6; }

.mono { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.tail { background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: .5rem; max-height: 15em; overflow: auto; margin: 0; }
.progress { letter-spacing: 1px; }

.folder { display: flex; flex-direction: column; gap: .4rem; margin-bottom: .75rem; }
.folder .badge { align-self: flex-start; }

.subtabs { display: flex; gap: .25rem; margin-bottom: .5rem; }
.subtab { padding: .25rem .6rem; border-radius: 4px; color: var(--fg-dim); }
.subtab.active { background: var(--panel-2); color: var(--fg); }

.drawer { position: fixed; inset: 0; z-index: 10; }
.drawer[hidden] { display: none; }
.drawer-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
.drawer-body { position: absolute; right: 0; top: 0; bottom: 0; width: min(560px, 100vw); background: var(--panel); border-left: 1px solid var(--border); padding: 1rem; overflow: auto; }
.drawer-close { float: right; background: var(--panel-2); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: .25rem .6rem; cursor: pointer; }

.banner { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%); background: var(--bad); color: #fff; padding: .5rem 1rem; border-radius: 4px; font-family: var(--mono); font-size: 13px; z-index: 20; }
.banner code { background: rgba(0,0,0,.25); padding: 0 .25rem; border-radius: 2px; }
`;
