/* Plan B iPhone app. Reads JSON from the unauthenticated gist API.
   Setup values arrive only in the URL fragment (or a paste on the lock screen)
   and are stored in localStorage. In browser/Safari the fragment is left on
   the URL so Add to Home Screen keeps it. Those values are never written
   into this file. */
(function () {
  "use strict";

  var POLL_MS = 60000;
  var BACKOFF_MIN = 2000;
  var BACKOFF_MAX = 300000;
  var SK_D = "desk.d";
  var SK_T = "desk.t";
  var RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];

  var state = {
    files: {},
    tab: "home",
    range: "LIVE",
    screen: "tab", // tab | coin | audit | search | settings
    mint: null,
    settingsGroup: null,
    lastOk: null,
    lastError: null,
    retryIn: 0,
    backoff: 0,
    timer: null,
    reduced: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  };

  var el = {
    app: $("app"),
    lock: $("lock"),
    view: $("view"),
    banner: $("banner"),
    tabbar: $("tabbar")
  };

  function $(id) { return document.getElementById(id); }

  function storeGet(k) {
    try { return window.localStorage.getItem(k) || ""; } catch (e) { return ""; }
  }
  function storeSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) {}
  }
  function dataId() { return storeGet(SK_D); }
  function hasSetup() { return !!dataId(); }

  function isStandalone() {
    return (window.navigator && window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  /* Parse a full private URL, a #fragment, or a t=...&d=... string.
     Stores values in localStorage. Never logs the raw string. */
  function applySetupFromString(raw) {
    if (!raw) return false;
    var s = String(raw).trim();
    var hash = "";
    var i = s.indexOf("#");
    if (i >= 0) hash = s.slice(i + 1);
    else if (/[?&]?[td]=/.test(s)) hash = s.replace(/^[?#]/, "");
    if (!hash) return false;
    var q;
    try { q = new URLSearchParams(hash); } catch (e) { return false; }
    var tok = q.get("t");
    var d = q.get("d");
    if (tok) storeSet(SK_T, tok);
    if (d) storeSet(SK_D, d);
    return !!storeGet(SK_D);
  }

  function consumeFragment() {
    var raw = window.location.hash || "";
    if (!raw || raw.length < 2) return;
    applySetupFromString(raw);
    // Browser/Safari: keep the fragment so Add to Home Screen saves it.
    // Standalone: localStorage already has the values; do not strip if present.
  }

  function fmtMoney(n, digits) {
    if (n == null || !isFinite(Number(n))) return "—";
    var d = digits == null ? 2 : digits;
    var v = Number(n);
    var abs = Math.abs(v);
    var dec = abs >= 1000 ? 2 : abs >= 1 ? d : abs >= 0.01 ? 4 : 6;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: dec });
  }
  function fmtPct(n, withSign) {
    if (n == null || !isFinite(Number(n))) return "—";
    var v = Number(n);
    var t = (withSign && v > 0 ? "+" : "") + v.toFixed(2) + "%";
    return t;
  }
  function fmtMult(n) {
    if (n == null || !isFinite(Number(n))) return "—";
    return Number(n).toFixed(2) + "×";
  }
  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function fmtWhen(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function pctClass(n) {
    if (n == null || !isFinite(Number(n)) || Number(n) === 0) return "pct-flat";
    return Number(n) > 0 ? "pct-up" : "pct-down";
  }
  function file(name) { return state.files[name] || null; }
  function snap() { return file("state.json") || {}; }
  function account() { return file("account.json") || {}; }
  function settings() { return file("settings.json") || {}; }
  function activity() { return file("activity.json") || { rows: [] }; }
  function chart(range) { return file("chart_" + range + ".json") || { points: [], marks: [] }; }
  function decisions(name) { return file("agents_" + name + "_decisions.json") || { decisions: [] }; }
  function coinFile(mint) { return file("coin_" + mint + ".json"); }
  function auditFile(mint) { return file("audit_" + mint + ".json"); }

  function prettyKey(key) {
    return key.replace(/^(scanner|auditor|executor|risk)_/, "").replace(/_/g, " ");
  }

  /* ---------- fetch ---------- */
  function gistUrl() {
    // Path is built at runtime from localStorage. It is never hardcoded here.
    return "https://api.github.com/gists/" + encodeURIComponent(dataId());
  }

  function fetchDesk() {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    return fetch(gistUrl(), {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      if (res.status === 403 || res.status === 429) {
        var ra = res.headers.get("Retry-After");
        var wait = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : nextBackoff();
        var err = new Error("rate");
        err.code = res.status;
        err.retry = wait;
        throw err;
      }
      if (!res.ok) {
        var e = new Error("http");
        e.code = res.status;
        throw e;
      }
      return res.json();
    }).then(function (body) {
      return readFiles(body && body.files);
    }).then(function (files) {
      state.files = files;
      state.lastOk = new Date();
      state.lastError = null;
      state.backoff = 0;
      render();
    }).catch(function (err) {
      var wait = (err && err.retry) || nextBackoff();
      state.lastError = err;
      state.retryIn = wait;
      renderBanner();
      schedule(wait);
    });
  }

  function nextBackoff() {
    state.backoff = Math.min(Math.max((state.backoff || BACKOFF_MIN / 2) * 2, BACKOFF_MIN), BACKOFF_MAX);
    return state.backoff;
  }

  function readFiles(files) {
    files = files || {};
    var jobs = Object.keys(files).map(function (name) {
      var f = files[name] || {};
      if (f.truncated && f.raw_url) {
        return fetch(f.raw_url, { cache: "no-store" }).then(function (r) { return r.json(); })
          .then(function (j) { return [name, j]; })
          .catch(function () { return [name, parseMaybe(f.content)]; });
      }
      return Promise.resolve([name, parseMaybe(f.content)]);
    });
    return Promise.all(jobs).then(function (pairs) {
      var out = {};
      pairs.forEach(function (p) { if (p[1] != null) out[p[0]] = p[1]; });
      return out;
    });
  }
  function parseMaybe(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function schedule(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () { fetchDesk(); }, ms || POLL_MS);
  }

  /* ---------- render ---------- */
  function render() {
    renderBanner();
    if (state.screen === "coin") renderCoin(state.mint);
    else if (state.screen === "audit") renderAudit(state.mint);
    else if (state.screen === "search") renderSearch();
    else if (state.screen === "settings") renderSettings(state.settingsGroup);
    else renderTab(state.tab);
    syncTabs();
  }

  function renderBanner() {
    var b = el.banner;
    if (!state.lastError) {
      b.classList.add("hidden");
      b.hidden = true;
      b.textContent = "";
      return;
    }
    var secs = Math.max(1, Math.round((state.retryIn || POLL_MS) / 1000));
    var last = state.lastOk ? state.lastOk.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "never";
    b.textContent = "Desk offline · retrying in " + secs + "s · last update " + last;
    b.classList.remove("hidden");
    b.hidden = false;
  }

  function syncTabs() {
    var onTab = state.screen === "tab";
    el.tabbar.style.display = onTab ? "flex" : "none";
    el.view.classList.toggle("sub", !onTab);
    Array.prototype.forEach.call(el.tabbar.querySelectorAll(".tab-btn"), function (btn) {
      btn.classList.toggle("is-on", btn.getAttribute("data-tab") === state.tab);
    });
  }

  function renderTab(tab) {
    state.tab = tab;
    state.screen = "tab";
    syncTabs();
    if (tab === "home") renderHome();
    else if (tab === "agents") renderAgents();
    else if (tab === "activity") renderActivity();
    else renderAccount();
    requestAnimationFrame(drawVisibleCharts);
  }

  /* Home */
  function renderHome() {
    var s = snap();
    var mode = s.mode || "PAPER";
    var bal = s.balance;
    var today = s.today_pct;
    var mult = s.multiplier;
    var agents = s.agents || [];
    var running = s.agents_running != null ? s.agents_running : agents.filter(function (a) { return a.status === "running"; }).length;
    var rows = s.activity || [];
    var unread = s.unread_pushes || 0;
    var html = "";
    html += navBar(true, unread);
    html += '<div class="balance-block">';
    html += '<div class="balance-row">';
    html += odometerHtml(bal);
    if (mode === "PAPER") html += '<span class="paper-pill">PAPER</span>';
    html += "</div>";
    html += '<div class="meta-row">';
    html += '<span class="' + pctClass(today) + '">' + esc(fmtPct(today, true)) + "</span>";
    if (mult != null) html += '<span class="mult-pill">' + esc(fmtMult(mult)) + "</span>";
    html += "</div></div>";

    html += '<div class="chart-wrap"><div class="chart-canvas-box" id="line-box">';
    html += '<canvas id="line-chart"></canvas>';
    var ch = chart(state.range);
    var emptyChart = !(ch.points && ch.points.length > 1) && !(ch.marks && ch.marks.length);
    if (emptyChart) html += '<div class="chart-empty">Waiting for the first trade</div>';
    html += "</div>";
    html += '<div class="ranges">';
    RANGES.forEach(function (r) {
      html += '<button type="button" data-range="' + r + '" class="' + (state.range === r ? "is-on" : "") + '">' + r + "</button>";
    });
    html += "</div></div>";

    html += '<div class="section-head"><h2>Agents · ' + running + " running</h2></div>";
    html += '<div class="carousel" id="carousel">';
    if (!agents.length) {
      html += '<article class="agent-card"><div class="agent-phrase">Listening for graduations</div></article>';
    } else {
      agents.forEach(function (a) { html += agentCard(a); });
    }
    html += "</div>";

    html += '<div class="section-head"><h2>Activity</h2><button type="button" class="link" data-go="activity">See all</button></div>';
    html += activityList(rows, "Nothing yet tonight");
    el.view.innerHTML = html;
  }

  function deskHandle() {
    var raw = (snap().fomo_handle || account().fomo_handle || "").replace(/^@/, "");
    return raw;
  }

  function navBar(home, unread) {
    var handle = deskHandle();
    var title = handle || "Desk";
    var initial = (handle ? handle.charAt(0) : "D").toUpperCase();
    var h = '<header class="nav">';
    h += '<button type="button" class="avatar" data-go="account" aria-label="Account">' + esc(initial) + "</button>";
    h += "<h1>" + esc(title) + ' <span style="color:var(--tertiary)">›</span></h1>';
    h += '<button type="button" class="icon-btn" data-go="search" aria-label="Search">' + iconSearch() + "</button>";
    h += '<button type="button" class="icon-btn" data-go="activity" aria-label="Activity">';
    h += iconBell();
    if (unread) h += '<span class="bell-dot"></span>';
    h += "</button></header>";
    return h;
  }

  function odometerHtml(bal) {
    var text = fmtMoney(bal, 2);
    var out = '<div class="odometer" aria-label="' + esc(text) + '">';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (/\d/.test(ch)) {
        out += '<span class="digit" data-d="' + ch + '"><span style="transform:translateY(-' + ch + "em)\">";
        for (var n = 0; n <= 9; n++) out += "<i>" + n + "</i>";
        out += "</span></span>";
      } else {
        out += '<span class="sep">' + esc(ch) + "</span>";
      }
    }
    out += "</div>";
    return out;
  }

  function agentCard(a) {
    var name = a.name || "";
    var title = a.title || cap(name);
    var h = '<article class="agent-card" data-open-agent="' + esc(name) + '">';
    h += '<div class="agent-card-top">';
    h += '<span class="status-dot ' + esc(a.status || "offline") + '"></span>';
    h += '<span class="agent-name">' + esc(title) + "</span>";
    h += '<span class="agent-count">' + esc(agentCountLabel(a)) + "</span>";
    h += "</div>";
    if (name === "scanner") {
      var feed = a.feed || [];
      h += '<div class="agent-phrase">' + (feed.length ? esc(a.pools || a.today_count || 0) + " pools" : "Listening for graduations") + "</div>";
      h += '<div class="feed">';
      feed.slice(0, 5).forEach(function (row) {
        var killed = row.verdict === "kill" || row.verdict === "killed";
        h += '<div class="feed-row">';
        h += '<span class="' + (killed ? "killed" : "") + '">' + esc(row.name || "") + "</span>";
        if (killed) h += '<span class="reason">' + esc(row.reason || "") + "</span>";
        else if (row.verdict === "pass") h += '<span class="pass">→ auditor</span>';
        h += "</div>";
      });
      h += "</div>";
    } else if (name === "auditor") {
      h += '<div class="agent-phrase">' + esc(a.phrase || (a.taken_apart ? a.taken_apart + " taken apart" : "No coin taken apart yet")) + "</div>";
      h += '<div class="strips">';
      var strips = a.layer_strips || [];
      for (var i = 1; i <= 8; i++) {
        var st = strips.filter(function (x) { return x.layer === i; })[0];
        var cls = "strip";
        if (st && st.pass === true) cls += " on";
        else if (st && st.pass === false) cls += " red";
        h += '<div class="' + cls + '"></div>';
      }
      h += "</div>";
      h += '<div class="agent-count" style="margin:10px 0 0">' + esc((a.rejected || 0) + " rejected") + "</div>";
    } else if (name === "analyst") {
      h += '<div class="agent-phrase">Scoring</div>';
      h += '<div class="score-row"><div style="width:88px;height:88px"><canvas class="score-ring" data-score="' + esc(a.score) + '" data-min="' + esc(a.score_min || 70) + '"></canvas></div>';
      h += '<div class="muted">' + (a.score == null ? "Waiting for a coin" : "Score " + esc(a.score)) + "</div></div>";
    } else if (name === "executor") {
      h += '<div class="agent-phrase">' + esc((a.trades || a.today_count || 0) + " trades") + "</div>";
      if (a.size_usd != null) {
        h += '<div class="muted">' + esc(fmtMoney(a.size_usd) + " · " + (a.stack_pct != null ? a.stack_pct + "% of stack" : "")) + "</div>";
      } else {
        h += '<div class="muted">Waiting to size a ticket</div>';
      }
      if (a.filled) h += '<div class="exec-note">✓ Filled</div>';
      else h += '<div class="exec-bar"><span style="width:' + (a.filled ? "100" : "0") + '%"></span></div>';
    } else if (name === "risk") {
      h += '<div class="agent-phrase">' + esc(a.phrase || "Guarding") + "</div>";
      h += '<div class="pills">';
      if (a.stop_pct != null) h += '<span class="th-pill stop">stop -' + esc(a.stop_pct) + "%</span>";
      if (a.trail_pct != null) h += '<span class="th-pill trail">trail ' + esc(a.trail_pct) + "%</span>";
      h += "</div>";
    }
    h += "</article>";
    return h;
  }

  function agentCountLabel(a) {
    var n = a.today_count;
    if (a.name === "scanner") return (a.pools != null ? a.pools : n) + " today";
    if (a.name === "auditor") return (a.taken_apart != null ? a.taken_apart : n) + " today";
    if (a.name === "executor") return (a.trades != null ? a.trades : n) + " today";
    return (n != null ? n : 0) + " today";
  }

  function activityList(rows, emptyText) {
    if (!rows || !rows.length) return '<div class="empty">' + esc(emptyText) + "</div>";
    var h = '<div class="list">';
    rows.forEach(function (r) {
      var cls = "row-val";
      if (r.kind === "sold" || (typeof r.value === "string" && r.value.charAt(0) === "+")) cls += " up";
      if (r.kind === "stopped" || (typeof r.value === "string" && r.value.charAt(0) === "-")) cls += " down";
      h += '<button type="button" class="act-row" data-act-mint="' + esc(r.mint || "") + '" data-act-screen="' + esc(r.screen || "") + '" data-act-url="' + esc(r.coin_url || "") + '">';
      h += '<div class="mid"><div class="act-title">' + esc(actTitle(r)) + "</div>";
      h += '<div class="act-sub">' + esc(actSub(r)) + "</div></div>";
      h += '<div class="' + cls + '">' + esc(r.value || "") + "</div>";
      h += "</button>";
    });
    h += "</div>";
    return h;
  }
  function actTitle(r) {
    if (r.title) {
      if (/^Bought |^Sold |^Stopped |^Rejected /.test(r.title)) return r.title;
      var verb = { bought: "Bought", sold: "Sold", stopped: "Stopped", rejected: "Rejected" }[r.kind];
      return verb ? verb + " " + r.title : r.title;
    }
    return r.kind || "";
  }
  function actSub(r) {
    var bits = [];
    if (r.subtitle) bits.push(r.subtitle);
    else if (r.agent) bits.push(cap(r.agent));
    if (r.ts) bits.push(fmtTime(r.ts));
    return bits.join(" · ");
  }

  /* Agents tab */
  function renderAgents() {
    var s = snap();
    var agents = s.agents || [];
    var names = ["scanner", "auditor", "analyst", "executor", "risk"];
    var h = '<header class="nav"><h1>Agents</h1></header>';
    names.forEach(function (name) {
      var card = agents.filter(function (a) { return a.name === name; })[0] || { name: name, title: cap(name), status: "offline" };
      var dec = decisions(name);
      var list = (dec.decisions && dec.decisions.length ? dec.decisions : card.decisions) || [];
      h += '<section class="agent-panel">';
      h += '<div class="agent-panel-head">';
      h += '<span class="status-dot ' + esc(card.status || "offline") + '"></span>';
      h += "<h2>" + esc(card.title || cap(name)) + "</h2>";
      h += '<span class="agent-count">' + esc((dec.today_count != null ? dec.today_count : card.today_count || 0) + " today") + "</span>";
      var on = !card.paused;
      h += '<span class="toggle' + (on ? " on" : "") + '" title="Read-only" aria-disabled="true"><i></i></span>';
      h += "</div>";
      h += '<p class="ro-note">Pause and resume from Telegram.</p>';
      if (!list.length) h += '<div class="empty" style="padding:12px 0">No decisions yet tonight</div>';
      else {
        list.slice(0, 20).forEach(function (d) {
          h += '<button type="button" class="dec-row" data-act-mint="' + esc(d.mint || "") + '" data-act-url="' + esc(d.coin_url || "") + '" data-act-screen="' + (name === "auditor" || d.verdict === "rejected" || d.verdict === "kill" ? "auditor" : "coin") + '">';
          h += '<div class="mid"><div class="dec-title">' + esc(d.name || d.mint || "") + "</div>";
          h += '<div class="dec-sub">' + esc([fmtTime(d.ts), d.verdict, d.reason].filter(Boolean).join(" · ")) + "</div></div>";
          h += "</button>";
        });
      }
      h += '<button type="button" class="settings-link" data-settings="' + esc(name) + '">Settings</button>';
      h += "</section>";
    });
    el.view.innerHTML = h;
  }

  /* Activity tab */
  function renderActivity() {
    var rows = (activity().rows) || [];
    var h = '<header class="nav"><h1>Activity</h1></header>';
    h += activityList(rows, "Nothing yet tonight");
    el.view.innerHTML = h;
  }

  /* Account */
  function renderAccount() {
    var a = account();
    var mode = a.mode || snap().mode || "PAPER";
    var h = '<header class="nav"><h1>Account</h1></header>';
    h += '<div class="mode-switch" data-mode-box="1">';
    h += '<span class="' + (mode === "PAPER" ? "is-on" : "") + '">PAPER</span>';
    h += '<span class="' + (mode === "LIVE" ? "is-on" : "") + '">LIVE</span>';
    h += "</div>";
    h += '<p class="note">Mode is read-only here. Switch it in Telegram.</p>';
    h += '<div class="stack-box"><div class="stack-label">Stack</div>';
    h += '<div class="stack-val num">' + esc(fmtMoney(a.stack != null ? a.stack : snap().balance)) + "</div></div>";

    h += rowLink("Your FOMO profile", a.fomo_handle ? "@" + a.fomo_handle : "", a.profile_url);
    h += rowAction("Invite a friend", "Share the signup link", "invite");

    var tg = a.telegram && a.telegram.connected;
    h += '<div class="group-title">Alerts</div>';
    h += rowStatic("Telegram", tg ? "Connected" : "Not connected");
    h += rowStatic("Notifications", a.web_push ? "Web push on" : "Telegram only · no web push");
    if (a.web_push_reason) h += '<p class="note">' + esc(a.web_push_reason) + "</p>";

    h += '<div class="group-title">Settings</div>';
    var groups = (settings().groups) || {};
    var groupOrder = ["scanner", "auditor", "analyst", "executor", "risk", "desk"];
    groupOrder.concat(Object.keys(groups)).filter(function (g, i, arr) {
      return groups[g] && arr.indexOf(g) === i;
    }).forEach(function (g) {
      h += '<button type="button" class="account-row" data-settings="' + esc(g) + '">';
      h += '<div class="mid"><div class="act-title">' + esc(cap(g)) + "</div>";
      h += '<div class="act-sub">Read-only · change in Telegram</div></div>';
      h += '<div class="row-val">›</div></button>';
    });
    if (settings().note || a.commands_note) {
      h += '<p class="note">' + esc(settings().note || a.commands_note) + "</p>";
    }
    el.view.innerHTML = h;
  }

  function rowLink(title, sub, url) {
    if (!url) return rowStatic(title, sub);
    return '<a class="account-row" href="' + esc(url) + '" target="_blank" rel="noopener"><div class="mid"><div class="act-title">' + esc(title) + "</div>" +
      (sub ? '<div class="act-sub">' + esc(sub) + "</div>" : "") + '</div><div class="row-val">›</div></a>';
  }
  function rowAction(title, sub, act) {
    return '<button type="button" class="account-row" data-act="' + esc(act) + '"><div class="mid"><div class="act-title">' + esc(title) + "</div>" +
      (sub ? '<div class="act-sub">' + esc(sub) + "</div>" : "") + '</div><div class="row-val">›</div></button>';
  }
  function rowStatic(title, sub) {
    return '<div class="account-row"><div class="mid"><div class="act-title">' + esc(title) + "</div>" +
      (sub ? '<div class="act-sub">' + esc(sub) + "</div>" : "") + "</div></div>";
  }

  function renderSettings(group) {
    state.screen = "settings";
    state.settingsGroup = group;
    syncTabs();
    var groups = (settings().groups) || {};
    var keys = group && groups[group] ? [[group, groups[group]]] : Object.keys(groups).map(function (g) { return [g, groups[g]]; });
    var h = '<header class="nav"><button type="button" class="back-btn" data-back="1" aria-label="Back">' + iconBack() + "</button>";
    h += "<h1>Settings</h1></header>";
    h += '<p class="note">Every setting is read-only in this app. Change them through Telegram.</p>';
    keys.forEach(function (pair) {
      h += '<div class="group-title">' + esc(cap(pair[0])) + "</div><div class=\"list\">";
      Object.keys(pair[1] || {}).forEach(function (k) {
        h += '<div class="setting-row"><div class="mid"><div class="name">' + esc(prettyKey(k)) + "</div></div>";
        h += '<div class="val">' + esc(pair[1][k]) + "</div></div>";
      });
      h += "</div>";
    });
    el.view.innerHTML = h;
  }

  /* Coin */
  function lookupActivity(mint) {
    var rows = (activity().rows || []).concat(snap().activity || []);
    for (var i = 0; i < rows.length; i++) if (rows[i].mint === mint) return rows[i];
    var names = ["scanner", "auditor", "analyst", "executor", "risk"];
    for (i = 0; i < names.length; i++) {
      var list = (decisions(names[i]).decisions) || [];
      for (var j = 0; j < list.length; j++) if (list[j].mint === mint) return list[j];
    }
    return null;
  }

  function renderCoin(mint) {
    state.screen = "coin";
    state.mint = mint;
    syncTabs();
    var c = coinFile(mint) || {};
    var row = lookupActivity(mint) || {};
    var name = c.name || row.name || row.title || mint.slice(0, 6);
    var mode = c.mode || snap().mode;
    var url = c.coin_url || row.coin_url || "";
    var pos = c.position;
    var open = pos && pos.open;
    var h = '<header class="nav"><button type="button" class="back-btn" data-back="1" aria-label="Back">' + iconBack() + "</button>";
    h += '<div class="title">' + esc(name);
    if (mode === "PAPER") h += ' <span class="paper-pill" style="margin-left:8px;margin-top:0;vertical-align:middle">PAPER</span>';
    h += "</div>";
    if (c.shield && c.shield !== "n/a") h += '<span class="shield-pill" style="background:var(--card-2)">' + esc(c.shield) + "</span>";
    h += "</header>";
    h += '<div class="sub-head"><div class="coin-kicker">' + esc([c.symbol || "", "Solana", c.age].filter(Boolean).join(" · ")) + "</div>";
    if (c.price != null) h += '<div class="price-big">' + esc(fmtMoney(c.price, 6)) + "</div>";
    if (c.since_entry_pct != null) {
      h += '<div class="meta-row"><span class="' + pctClass(c.since_entry_pct) + '">' +
        (c.since_entry_pct >= 0 ? "▲ " : "▼ ") + esc(fmtPct(Math.abs(c.since_entry_pct))) + " since entry</span></div>";
    }
    h += "</div>";
    h += '<div class="chart-canvas-box" id="candle-box" style="height:220px;margin-top:8px"><canvas id="candle-chart"></canvas></div>';
    var st = c.stats || {};
    h += '<div class="stats-grid">';
    h += stat("Market cap", st.market_cap != null ? fmtMoney(st.market_cap, 0) : "—");
    h += stat("Liquidity", st.liquidity != null ? fmtMoney(st.liquidity, 0) : "—");
    h += stat("24h volume", st.volume_24h != null ? fmtMoney(st.volume_24h, 0) : "—");
    h += stat("Holders", st.holders == null ? "n/a" : String(st.holders));
    h += "</div>";
    if (open && pos) {
      h += '<div class="pos-card"><h3>Your position · ' + esc(fmtMoney(pos.size_usd)) + " in · Executor</h3>";
      h += '<div class="muted">Entry ' + esc(fmtMoney(pos.entry_price, 6)) + "</div></div>";
      h += '<div class="exit-card"><h3>Exit</h3>';
      if (c.exit_lines && c.exit_lines.stop != null) h += '<div>Stop ' + esc(fmtMoney(c.exit_lines.stop, 6)) + "</div>";
      if (c.exit_lines && c.exit_lines.trail != null) h += '<div>Trail ' + esc(fmtMoney(c.exit_lines.trail, 6)) + "</div>";
      if (pos.time_left_s != null) h += '<div class="muted">Time left ' + esc(fmtDuration(pos.time_left_s)) + "</div>";
      h += "</div>";
    }
    var audit = auditFile(mint);
    if (audit) {
      h += '<button type="button" class="account-row" data-open-audit="' + esc(mint) + '" style="padding-left:16px;padding-right:16px">';
      h += '<div class="mid"><div class="act-title">Audit</div><div class="act-sub">' + esc(audit.headline || audit.status || "8 layers") + "</div></div>";
      h += '<div class="row-val">›</div></button>';
    }
    if (url) {
      h += '<a class="cta" href="' + esc(url) + '" target="_blank" rel="noopener">' +
        esc((c.button || (open ? "Sell on FOMO" : "Buy on FOMO"))) + "</a>";
    }
    el.view.innerHTML = h;
    requestAnimationFrame(drawVisibleCharts);
  }

  function stat(lbl, val) {
    return '<div><div class="stat-lbl">' + esc(lbl) + '</div><div class="stat-val">' + esc(val) + "</div></div>";
  }
  function fmtDuration(s) {
    s = Math.max(0, Number(s) || 0);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + "h " + m + "m";
    return m + "m";
  }

  /* Auditor */
  function renderAudit(mint) {
    state.screen = "audit";
    state.mint = mint;
    syncTabs();
    var a = auditFile(mint);
    var row = lookupActivity(mint) || {};
    var name = (a && a.name) || row.name || row.title || (mint || "").slice(0, 6);
    var url = (a && a.coin_url) || row.coin_url || "";
    var h = '<header class="nav"><button type="button" class="back-btn" data-back="1" aria-label="Back">' + iconBack() + "</button>";
    h += '<div class="title">' + esc(name) + "</div></header>";
    if (!a || !(a.layers && a.layers.length)) {
      h += '<div class="empty">No coin taken apart yet</div>';
      if (url) h += '<a class="cta" href="' + esc(url) + '" target="_blank" rel="noopener">Open on FOMO</a>';
      el.view.innerHTML = h;
      return;
    }
    h += '<div class="discs" id="discs">';
    a.layers.forEach(function (L) {
      h += '<div class="disc" data-layer="' + esc(L.layer) + '"><div class="beam"></div></div>';
    });
    h += "</div>";
    if (a.headline) h += '<div class="headline">' + esc(a.headline) + "</div>";
    if (a.subhead) h += '<div class="subhead">' + esc(a.subhead) + "</div>";
    h += '<div class="layer-rows">';
    a.layers.forEach(function (L) {
      h += '<div class="layer-row"><span class="n">' + esc(L.layer + " · " + (L.name || "")) + "</span>";
      h += '<span class="v">' + esc(L.value_text == null ? "—" : L.value_text) + "</span></div>";
    });
    h += "</div>";
    h += '<p class="note">“Take apart before buying” is read-only here. Change it in Telegram.</p>';
    if (url) h += '<a class="cta" href="' + esc(url) + '" target="_blank" rel="noopener">Open on FOMO</a>';
    el.view.innerHTML = h;
    playBeam(a.layers);
  }

  function playBeam(layers) {
    var discs = el.view.querySelectorAll(".disc");
    if (!discs.length) return;
    if (state.reduced) {
      layers.forEach(function (L, i) { paintDisc(discs[i], L.pass); });
      return;
    }
    var i = 0;
    function step() {
      if (i >= layers.length) return;
      var node = discs[i];
      var pass = layers[i].pass;
      if (pass == null) { i += 1; step(); return; }
      node.classList.add("scanning");
      setTimeout(function () {
        node.classList.remove("scanning");
        setTimeout(function () {
          paintDisc(node, pass);
          i += 1;
          step();
        }, 150);
      }, 350);
    }
    step();
  }
  function paintDisc(node, pass) {
    if (!node) return;
    node.classList.remove("ok", "bad");
    if (pass === true) node.classList.add("ok");
    else if (pass === false) node.classList.add("bad");
  }

  /* Search */
  function renderSearch(q) {
    state.screen = "search";
    syncTabs();
    q = (q || "").trim().toLowerCase();
    var found = searchCoins(q);
    var h = '<div class="sheet"><div class="sheet-bar">';
    h += '<input id="search-q" type="search" placeholder="Name, symbol or mint" value="' + esc(q) + '" autofocus />';
    h += '<button type="button" class="sheet-cancel" data-back="1">Cancel</button></div>';
    if (!q) h += '<div class="empty">Search tonight’s coins</div>';
    else if (!found.length) h += '<div class="empty">No match</div>';
    else h += activityList(found, "");
    h += "</div>";
    el.view.innerHTML = h;
    var input = $("search-q");
    if (input) {
      input.focus();
      input.addEventListener("input", function () { renderSearch(input.value); });
    }
  }

  function searchCoins(q) {
    var map = {};
    function add(r, screen) {
      if (!r || !r.mint) return;
      var name = (r.name || r.title || "") + " " + (r.symbol || "") + " " + r.mint;
      if (q && name.toLowerCase().indexOf(q) === -1) return;
      if (!map[r.mint]) {
        map[r.mint] = {
          mint: r.mint,
          title: r.name || r.title || r.mint,
          subtitle: r.symbol || r.mint.slice(0, 8),
          value: "",
          kind: r.kind,
          screen: screen || r.screen || "coin",
          coin_url: r.coin_url,
          ts: r.ts
        };
      }
    }
    (activity().rows || []).forEach(function (r) { add(r, r.screen); });
    (snap().activity || []).forEach(function (r) { add(r, r.screen); });
    (snap().agents || []).forEach(function (a) {
      (a.feed || []).concat(a.decisions || []).forEach(function (r) { add(r, a.name === "auditor" ? "auditor" : "coin"); });
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  /* Charts after paint */
  function drawVisibleCharts() {
    var Charts = window.DeskCharts;
    if (!Charts) return;
    var line = $("line-chart");
    if (line) {
      var data = chart(state.range);
      Charts.drawLineChart(line, data, { reduced: state.reduced });
    }
    var candle = $("candle-chart");
    if (candle && state.mint) {
      var c = coinFile(state.mint) || {};
      var lines = c.exit_lines || {};
      Charts.drawCandles(candle, c, { stop: lines.stop, trail: lines.trail, reduced: state.reduced });
    }
    Array.prototype.forEach.call(document.querySelectorAll(".score-ring"), function (cv) {
      var s = cv.getAttribute("data-score");
      var m = cv.getAttribute("data-min");
      Charts.drawScoreRing(cv, s === "null" || s === "" ? null : Number(s), Number(m) || 70);
    });
  }

  /* Events */
  function onTap(e) {
    var t = e.target.closest("[data-tab], [data-range], [data-go], [data-back], [data-act], [data-act-mint], [data-settings], [data-open-audit], [data-open-agent], [data-mode-box]");
    if (!t) return;

    if (t.hasAttribute("data-tab")) {
      e.preventDefault();
      renderTab(t.getAttribute("data-tab"));
      return;
    }
    if (t.hasAttribute("data-range")) {
      e.preventDefault();
      state.range = t.getAttribute("data-range");
      renderHome();
      requestAnimationFrame(drawVisibleCharts);
      return;
    }
    if (t.getAttribute("data-go") === "account") { e.preventDefault(); renderTab("account"); return; }
    if (t.getAttribute("data-go") === "activity") { e.preventDefault(); renderTab("activity"); return; }
    if (t.getAttribute("data-go") === "search") { e.preventDefault(); renderSearch(""); return; }
    if (t.hasAttribute("data-back")) {
      e.preventDefault();
      if (state.screen === "audit" && state.mint && coinFile(state.mint)) renderCoin(state.mint);
      else if (state.screen === "settings" && state.tab === "agents") renderTab("agents");
      else renderTab(state.tab || "home");
      return;
    }
    if (t.getAttribute("data-act") === "invite") { e.preventDefault(); invite(); return; }
    if (t.hasAttribute("data-settings")) {
      e.preventDefault();
      renderSettings(t.getAttribute("data-settings"));
      return;
    }
    if (t.hasAttribute("data-open-audit")) {
      e.preventDefault();
      renderAudit(t.getAttribute("data-open-audit"));
      return;
    }
    if (t.hasAttribute("data-mode-box")) {
      e.preventDefault();
      toast("Change mode in Telegram.");
      return;
    }
    if (t.hasAttribute("data-act-mint")) {
      e.preventDefault();
      openFromRow(t.getAttribute("data-act-mint"), t.getAttribute("data-act-screen"), t.getAttribute("data-act-url"));
    }
  }

  function openFromRow(mint, screen, url) {
    if (!mint) return;
    if (screen === "auditor") renderAudit(mint);
    else renderCoin(mint);
  }

  function invite() {
    var url = account().SIGNUP_URL || account().signup_url;
    if (!url) return;
    if (navigator.share) {
      navigator.share({ title: "FOMO", url: url }).catch(function () { copy(url); });
    } else {
      copy(url);
    }
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Link copied"); }).catch(function () { toast("Link copied"); });
    } else {
      toast("Link copied");
    }
  }
  function toast(msg) {
    var n = el.banner;
    var prevErr = state.lastError;
    n.textContent = msg;
    n.style.color = "var(--text)";
    n.style.background = "var(--card-2)";
    n.classList.remove("hidden");
    n.hidden = false;
    setTimeout(function () {
      n.style.color = "";
      n.style.background = "";
      state.lastError = prevErr;
      renderBanner();
    }, 1600);
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

  function iconSearch() {
    return '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 20 20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  }
  function iconBell() {
    return '<svg viewBox="0 0 24 24"><path d="M12 4a6 6 0 0 0-6 6v3.2L4.5 16h15L18 13.2V10a6 6 0 0 0-6-6zm-2.2 14a2.2 2.2 0 0 0 4.4 0z"/></svg>';
  }
  function iconBack() {
    return '<svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  /* Boot */
  function showLock(on) {
    el.lock.hidden = !on;
    el.lock.classList.toggle("hidden", !on);
    el.app.hidden = on;
    el.app.classList.toggle("hidden", on);
  }

  function bindLockForm() {
    var form = $("lock-form");
    if (!form || form.getAttribute("data-bound")) return;
    form.setAttribute("data-bound", "1");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var input = $("lock-paste");
      var err = $("lock-error");
      var raw = input ? input.value : "";
      if (!applySetupFromString(raw)) {
        if (err) {
          err.hidden = false;
          err.textContent = "That didn't look like the private link. Paste the whole thing, including the # part.";
        }
        return;
      }
      if (input) input.value = "";
      if (err) { err.hidden = true; err.textContent = ""; }
      startApp();
    });
  }

  var started = false;
  function startApp() {
    if (started) return;
    started = true;
    showLock(false);
    el.view.innerHTML = '<div class="balance-block"><div class="skel" style="height:72px;width:70%;margin:8px 0"></div><div class="skel" style="height:180px;width:100%;margin:16px 0"></div></div>';
    document.addEventListener("click", onTap);
    window.addEventListener("resize", function () { requestAnimationFrame(drawVisibleCharts); });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
    fetchDesk().then(function () { schedule(POLL_MS); });
  }

  function boot() {
    consumeFragment();
    bindLockForm();
    window.addEventListener("hashchange", function () {
      consumeFragment();
      if (hasSetup() && !started) startApp();
    });
    if (!hasSetup()) {
      showLock(true);
      return;
    }
    startApp();
  }

  boot();
})();
