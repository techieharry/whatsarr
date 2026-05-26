export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<meta name="color-scheme" content="dark light" />
<meta name="description" content="whatsarr operator dashboard — WhatsApp to Seerr bridge audit, queue, and admin pane." />
<title>whatsarr</title>
<link rel="stylesheet" href="/dashboard/app.css" />
</head>
<body>
<a href="#main" class="skip-link">skip to main content</a>
<header class="topbar">
  <div class="brand">whatsarr</div>
  <nav class="tabs" role="tablist" aria-label="dashboard sections">
    <a class="tab" data-tab="overview"  href="#overview"  role="tab" aria-controls="panel-overview"  id="tab-overview"  aria-selected="true"  tabindex="0">overview</a>
    <a class="tab" data-tab="requests"  href="#requests"  role="tab" aria-controls="panel-requests"  id="tab-requests"  aria-selected="false" tabindex="-1">requests</a>
    <a class="tab" data-tab="pending"   href="#pending"   role="tab" aria-controls="panel-pending"   id="tab-pending"   aria-selected="false" tabindex="-1">pending</a>
    <a class="tab" data-tab="syncthing" href="#syncthing" role="tab" aria-controls="panel-syncthing" id="tab-syncthing" aria-selected="false" tabindex="-1">syncthing</a>
    <a class="tab" data-tab="feedback"  href="#feedback"  role="tab" aria-controls="panel-feedback"  id="tab-feedback"  aria-selected="false" tabindex="-1">feedback</a>
    <a class="tab" data-tab="tasks"     data-write-only href="#tasks" role="tab" aria-controls="panel-tasks" id="tab-tasks" aria-selected="false" tabindex="-1" hidden>tasks</a>
  </nav>
  <div class="status" role="status" aria-live="polite" aria-atomic="false">
    <span id="conn-dot" class="dot dot-unknown" role="img" aria-label="connection unknown"></span>
    <span id="uptime" class="uptime">—</span>
    <span id="counters" class="counters"></span>
  </div>
</header>
<div id="conn-lost" class="banner" role="alert" hidden>dashboard cannot reach the bot. retrying…</div>

<main id="main">
  <section id="panel-overview" class="panel" role="tabpanel" aria-labelledby="tab-overview" hidden>
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

  <section id="panel-requests" class="panel" role="tabpanel" aria-labelledby="tab-requests" hidden>
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

  <section id="panel-pending" class="panel" role="tabpanel" aria-labelledby="tab-pending" hidden>
    <div class="scroll-x">
      <table id="pending-table" class="data">
        <thead><tr><th>id</th><th>target</th><th>text</th><th>attempts</th><th>last error</th><th class="th-actions" data-write-only hidden>actions</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <p id="pending-meta" class="meta">—</p>
  </section>

  <section id="panel-tasks" class="panel" role="tabpanel" aria-labelledby="tab-tasks" data-write-only hidden>
    <div class="card">
      <h2>run command</h2>
      <div id="tasks-commands" class="task-buttons"></div>
      <form id="task-dm-form" class="task-form" hidden>
        <label>to <input id="task-dm-to" type="text" placeholder="+15145551234 or jid" autocomplete="off" /></label>
        <label>text <input id="task-dm-text" type="text" placeholder="message body" autocomplete="off" /></label>
        <button type="submit">send</button>
        <button type="button" id="task-dm-cancel">cancel</button>
      </form>
      <p id="task-shutdown-notice" class="meta" hidden>service shutting down — restart NSSM to bring it back</p>
    </div>
    <div class="card">
      <h2>recent commands</h2>
      <div class="scroll-x">
        <table id="tasks-table" class="data">
          <thead><tr><th>id</th><th>time</th><th>name</th><th>status</th><th>duration</th><th>result/error</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </section>

  <section id="panel-syncthing" class="panel" role="tabpanel" aria-labelledby="tab-syncthing" hidden>
    <div id="syncthing-body"></div>
  </section>

  <section id="panel-feedback" class="panel" role="tabpanel" aria-labelledby="tab-feedback" hidden>
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
    <div id="drawer-error" class="drawer-error" hidden></div>
    <div id="drawer-actions" class="drawer-actions" data-write-only hidden></div>
    <pre id="drawer-json" class="mono"></pre>
  </aside>
</div>

<div id="auth-banner" class="banner" hidden>token expired, re-bookmark <code>?token=…</code></div>
<div id="toasts" class="toasts" aria-live="polite"></div>

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
  var FEATURES = BOOT.features || {};
  var WRITE = !!FEATURES.writeActions;

  var TABS = ['overview', 'requests', 'pending', 'syncthing', 'feedback'];
  var TIER = { overview: 'active', requests: 'active', pending: 'active', syncthing: 'static', feedback: 'static' };
  if (WRITE) { TABS.push('tasks'); TIER.tasks = 'active'; }
  var authFailed = false;
  var KNOWN_COMMANDS = [
    { name: 'reconnect_wa',  label: 'Reconnect WA' },
    { name: 'vacuum_db',     label: 'Vacuum DB' },
    { name: 'drain_pending', label: 'Drain pending' },
    { name: 'send_test_dm',  label: 'Send test DM' },
    { name: 'shutdown',      label: 'Shutdown' }
  ];

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
  function postJson(path, body) {
    var init = { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } };
    if (body !== undefined && body !== null) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(API + path, init).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') >= 0 ? r.json() : r.text().then(function (t) { return t ? { error: t } : {}; });
      return parse.then(function (data) {
        if (r.status === 401) { authFailed = true; showAuthBanner(); throw new Error('unauthorized'); }
        if (!r.ok) {
          var msg = (data && data.error) ? String(data.error) : ('http ' + r.status);
          var err = new Error(msg);
          err.status = r.status;
          err.body = data;
          throw err;
        }
        authFailed = false; hideAuthBanner();
        return data;
      });
    });
  }
  function showAuthBanner() { var b = $('auth-banner'); if (b) b.hidden = false; }
  function hideAuthBanner() { var b = $('auth-banner'); if (b) b.hidden = true; }

  function toast(msg, kind) {
    var box = $('toasts');
    if (!box) return;
    var k = (kind === 'err' || kind === 'info') ? kind : 'ok';
    var n = el('div', { cls: 'toast toast-' + k, text: String(msg) });
    box.appendChild(n);
    setTimeout(function () {
      n.classList.add('toast-out');
      setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 200);
    }, 3000);
  }

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
  function fmtDuration(startedAt, finishedAt) {
    var s = Number(startedAt);
    var f = Number(finishedAt);
    if (!Number.isFinite(s) || !Number.isFinite(f) || f < s) return '';
    return (f - s) + 'ms';
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
      var isActive = tabs[j].getAttribute('data-tab') === name;
      tabs[j].classList.toggle('active', isActive);
      tabs[j].setAttribute('aria-selected', isActive ? 'true' : 'false');
      tabs[j].setAttribute('tabindex', isActive ? '0' : '-1');
    }
    document.title = name === 'overview' ? 'whatsarr' : 'whatsarr — ' + name;
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
    var label = hb.connected ? 'baileys connected' : 'baileys disconnected';
    dot.title = label;
    dot.setAttribute('aria-label', label);
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
    renderDrawerActions(row);
    var errBox = $('drawer-error');
    if (errBox) { errBox.hidden = true; errBox.textContent = ''; }
    $('drawer').hidden = false;
  }

  function showDrawerError(msg) {
    var errBox = $('drawer-error');
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.hidden = false;
  }

  function renderDrawerActions(row) {
    var box = $('drawer-actions');
    if (!box) return;
    clear(box);
    if (!WRITE) { box.hidden = true; return; }
    var sid = row && row.seerrRequestId;
    if (sid == null) { box.hidden = true; return; }
    box.hidden = false;
    var status = String(row.status || '');
    var nonFinal = status !== 'succeeded';
    var btnApprove = el('button', { cls: 'btn btn-ok', text: 'Approve', attrs: { type: 'button' } });
    btnApprove.addEventListener('click', function () { actionSeerr(sid, 'approve'); });
    box.appendChild(btnApprove);
    if (nonFinal) {
      var btnDeny = el('button', { cls: 'btn btn-bad', text: 'Deny', attrs: { type: 'button' } });
      btnDeny.addEventListener('click', function () { actionSeerr(sid, 'deny'); });
      box.appendChild(btnDeny);
    }
    var btnRetry = el('button', { cls: 'btn', text: 'Retry', attrs: { type: 'button' } });
    btnRetry.addEventListener('click', function () { actionSeerr(sid, 'retry'); });
    box.appendChild(btnRetry);
  }

  function actionSeerr(seerrRequestId, kind) {
    var label = kind === 'approve' ? 'Approve' : kind === 'deny' ? 'Deny' : 'Retry';
    if (!confirm(label + ' request ' + seerrRequestId + '?')) return;
    postJson('/seerr/request/' + encodeURIComponent(seerrRequestId) + '/' + kind, null)
      .then(function () {
        var verb = kind === 'approve' ? 'approved' : kind === 'deny' ? 'denied' : 'retry queued';
        toast(verb, 'ok');
        $('drawer').hidden = true;
        fetchRequests();
      })
      .catch(function (err) {
        var msg = (err && err.message) ? err.message : 'error';
        showDrawerError(msg);
        toast(msg, 'err');
      });
  }

  function renderPending(payload) {
    var rows = payload.rows || [];
    var tbody = $('pending-table').querySelector('tbody');
    clear(tbody);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var errCell = el('td', { text: r.lastError ? trunc(r.lastError, 40) : '', title: r.lastError || '' });
      var cells = [
        el('td', { text: r.id }),
        el('td', { text: maskTarget(r.targetJid) }),
        el('td', { text: trunc(r.text || '', 80) }),
        el('td', { text: r.attempts }),
        errCell
      ];
      if (WRITE) {
        var actCell = el('td', { cls: 'cell-actions' });
        var retryBtn = el('button', { cls: 'btn btn-sm', text: 'retry', attrs: { type: 'button' } });
        var delBtn = el('button', { cls: 'btn btn-sm btn-bad', text: 'delete', attrs: { type: 'button' } });
        (function (id) {
          retryBtn.addEventListener('click', function () { actionPending(id, 'retry'); });
          delBtn.addEventListener('click', function () { actionPending(id, 'delete'); });
        })(r.id);
        actCell.appendChild(retryBtn);
        actCell.appendChild(delBtn);
        cells.push(actCell);
      }
      tbody.appendChild(el('tr', null, cells));
    }
    $('pending-meta').textContent = (payload.total || rows.length) + ' pending';
  }

  function actionPending(id, kind) {
    var label = kind === 'retry' ? 'Retry' : 'Delete';
    if (!confirm(label + ' pending notification ' + id + '?')) return;
    postJson('/pending/' + encodeURIComponent(id) + '/' + kind, null)
      .then(function () {
        toast(kind === 'retry' ? 'retry queued' : 'deleted', 'ok');
        fetchJson('/pending').then(renderPending).catch(noop);
      })
      .catch(function (err) { toast((err && err.message) || 'error', 'err'); });
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

  function renderTasks(payload) {
    var rows = (payload && payload.rows) || [];
    rows.sort(function (a, b) { return Number(b.id) - Number(a.id); });
    if (rows.length > 50) rows = rows.slice(0, 50);
    var tbody = $('tasks-table').querySelector('tbody');
    clear(tbody);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var resultText = r.error ? r.error : (r.result || '');
      var resultTd = el('td', { text: trunc(resultText, 120), title: resultText });
      var statusTd = el('td', null, [el('span', { cls: 'badge b-' + (r.status || 'unknown'), text: r.status || '' })]);
      tbody.appendChild(el('tr', null, [
        el('td', { text: r.id }),
        el('td', { text: fmtRelative(r.ts) }),
        el('td', { text: r.name || '' }),
        statusTd,
        el('td', { text: fmtDuration(r.startedAt, r.finishedAt) }),
        resultTd
      ]));
    }
  }

  function renderTaskCommands() {
    var box = $('tasks-commands');
    if (!box) return;
    clear(box);
    for (var i = 0; i < KNOWN_COMMANDS.length; i++) {
      var spec = KNOWN_COMMANDS[i];
      var btn = el('button', { cls: 'btn', text: spec.label, attrs: { type: 'button', 'data-cmd': spec.name } });
      (function (s, b) {
        b.addEventListener('click', function () { onCommandClick(s.name, s.label, b); });
      })(spec, btn);
      box.appendChild(btn);
    }
  }

  function flashQueued(btn) {
    if (!btn) return;
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'queued…';
    setTimeout(function () {
      btn.disabled = false;
      btn.textContent = orig;
    }, 1000);
  }

  function onCommandClick(name, label, btn) {
    if (name === 'send_test_dm') {
      var form = $('task-dm-form');
      if (form) form.hidden = false;
      var to = $('task-dm-to'); if (to) to.focus();
      return;
    }
    if (name === 'shutdown') {
      if (!confirm('Shutdown the service?')) return;
      if (!confirm('Really shutdown? NSSM must be restarted to bring it back.')) return;
      flashQueued(btn);
      postJson('/commands', { name: 'shutdown' })
        .then(function () {
          toast('shutdown queued', 'info');
          var notice = $('task-shutdown-notice');
          if (notice) notice.hidden = false;
          fetchJson('/tasks').then(renderTasks).catch(noop);
        })
        .catch(function (err) {
          toast((err && err.message) || 'error', 'err');
        });
      return;
    }
    if (!confirm('Run ' + label + '?')) return;
    flashQueued(btn);
    postJson('/commands', { name: name })
      .then(function () {
        toast(label + ' queued', 'ok');
        fetchJson('/tasks').then(renderTasks).catch(noop);
      })
      .catch(function (err) { toast((err && err.message) || 'error', 'err'); });
  }

  function submitTestDm(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    var to = ($('task-dm-to').value || '').trim();
    var text = ($('task-dm-text').value || '').trim();
    if (!to || !text) { toast('to and text required', 'err'); return; }
    postJson('/commands', { name: 'send_test_dm', args: { to: to, text: text } })
      .then(function () {
        toast('test DM queued', 'ok');
        $('task-dm-form').hidden = true;
        $('task-dm-to').value = '';
        $('task-dm-text').value = '';
        fetchJson('/tasks').then(renderTasks).catch(noop);
      })
      .catch(function (err) { toast((err && err.message) || 'error', 'err'); });
  }

  var hbFailStreak = 0;
  function pollHeartbeat() {
    fetchJson('/heartbeat').then(function (hb) {
      hbFailStreak = 0;
      $('conn-lost').hidden = true;
      renderHeartbeat(hb);
    }).catch(function () {
      hbFailStreak++;
      var dot = $('conn-dot');
      dot.classList.remove('dot-ok'); dot.classList.add('dot-bad');
      if (hbFailStreak >= 3) $('conn-lost').hidden = false;
    });
  }

  function refreshActive() {
    var tab = activeTab();
    if (TIER[tab] !== 'active') { refreshStatic(); return; }
    if (tab === 'overview') fetchJson('/overview').then(renderOverview).catch(noop);
    if (tab === 'requests') fetchRequests();
    if (tab === 'pending') fetchJson('/pending').then(renderPending).catch(noop);
    if (tab === 'tasks' && WRITE) fetchJson('/tasks').then(renderTasks).catch(noop);
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

  function applyWriteFeatureFlag() {
    var nodes = document.querySelectorAll('[data-write-only]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].hidden = !WRITE;
    }
  }

  function wireTasks() {
    if (!WRITE) return;
    renderTaskCommands();
    var form = $('task-dm-form');
    if (form) form.addEventListener('submit', submitTestDm);
    var cancel = $('task-dm-cancel');
    if (cancel) cancel.addEventListener('click', function () {
      var f = $('task-dm-form'); if (f) f.hidden = true;
    });
  }

  function wireTablistKeyboard() {
    var tablist = document.querySelector('[role="tablist"]');
    if (!tablist) return;
    tablist.addEventListener('keydown', function (e) {
      var key = e.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
      var visible = Array.from(tablist.querySelectorAll('[role="tab"]')).filter(function (t) { return !t.hasAttribute('hidden'); });
      if (visible.length === 0) return;
      var current = visible.indexOf(document.activeElement);
      var next = current;
      if (key === 'ArrowLeft')  next = (current <= 0) ? visible.length - 1 : current - 1;
      if (key === 'ArrowRight') next = (current + 1) % visible.length;
      if (key === 'Home')       next = 0;
      if (key === 'End')        next = visible.length - 1;
      e.preventDefault();
      visible[next].focus();
      var name = visible[next].getAttribute('data-tab');
      if (name) location.hash = '#' + name;
    });
  }

  function start() {
    applyWriteFeatureFlag();
    wireFilters();
    wireTasks();
    wireTablistKeyboard();
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
    --accent: #0969da;
    --ok: #1a7f37;
    --warn: #9a6700;
    --bad: #cf222e;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 var(--sans); }
a { color: var(--accent); text-decoration: none; }

.topbar { display: flex; align-items: center; gap: 1rem; padding: .5rem 1rem; border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 5; flex-wrap: wrap; }
.brand { font-weight: 600; letter-spacing: .03em; }
.tabs { display: flex; gap: .25rem; overflow-x: auto; flex: 1 1 100%; order: 3; -ms-overflow-style: none; scrollbar-width: thin; }
.tab { padding: .35rem .75rem; border-radius: 4px; color: var(--fg-dim); white-space: nowrap; outline-offset: 2px; }
.tab:hover { background: var(--panel-2); color: var(--fg); }
.tab:focus-visible { outline: 2px solid var(--accent); }
.tab.active { background: var(--panel-2); color: var(--fg); border-bottom: 2px solid var(--accent); }
@media (min-width: 900px) { .tabs { flex: 1 1 0%; order: 0; } }
.status { display: flex; align-items: center; gap: .75rem; color: var(--fg-dim); font-family: var(--mono); font-size: 12px; margin-left: auto; flex-shrink: 0; }
.uptime { min-width: 8ch; text-align: right; }
.counters { white-space: nowrap; }

.dot { width: .65rem; height: .65rem; border-radius: 50%; display: inline-block; }
.dot-ok { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.dot-bad { background: var(--bad); box-shadow: 0 0 6px var(--bad); }
.dot-unknown { background: var(--grey); }

main { padding: 1rem; max-width: 1400px; margin: 0 auto; }
[hidden] { display: none !important; }
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

.btn { background: var(--panel-2); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: .35rem .7rem; cursor: pointer; font: inherit; }
.btn:hover { background: var(--panel); }
.btn:disabled { opacity: .6; cursor: not-allowed; }
.btn-sm { padding: .15rem .4rem; font-size: 12px; }
.btn-ok { color: var(--ok); border-color: var(--ok); }
.btn-bad { color: var(--bad); border-color: var(--bad); }

.cell-actions { white-space: nowrap; }
.cell-actions .btn + .btn { margin-left: .35rem; }

.drawer-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: .75rem 0; }
.drawer-actions[hidden] { display: none; }
.drawer-error { background: rgba(248, 81, 73, .12); color: var(--bad); border: 1px solid var(--bad); border-radius: 4px; padding: .5rem .75rem; margin: .5rem 0; font-family: var(--mono); font-size: 12px; }
.drawer-error[hidden] { display: none; }

.task-buttons { display: flex; flex-wrap: wrap; gap: .5rem; }
.task-form { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; align-items: flex-end; }
.task-form[hidden] { display: none; }
.task-form label { display: flex; flex-direction: column; gap: .2rem; font-size: 12px; color: var(--fg-dim); }
.task-form input { background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: .3rem .5rem; font: inherit; min-width: 14rem; }

.b-running { color: var(--accent); border-color: var(--accent); }

.skip-link { position: absolute; top: -100px; left: 0; background: var(--accent); color: #fff; padding: .5rem 1rem; z-index: 100; }
.skip-link:focus { top: 0; outline: 2px solid #fff; outline-offset: -4px; }

.toasts { position: fixed; bottom: 1rem; right: 1rem; display: flex; flex-direction: column-reverse; gap: .35rem; z-index: 30; pointer-events: none; max-width: min(360px, 90vw); }
.toast { background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-left-width: 3px; border-radius: 4px; padding: .5rem .75rem; font-size: 13px; box-shadow: 0 2px 8px rgba(0,0,0,.35); pointer-events: auto; opacity: 1; transition: opacity .2s ease; }
.toast-out { opacity: 0; }
.toast-ok { border-left-color: var(--ok); }
.toast-err { border-left-color: var(--bad); }
.toast-info { border-left-color: var(--accent); }
`;
