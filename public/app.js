'use strict';
/* Stalldienst – Oberfläche (ohne Framework) */

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const modal = $('#modal');
const TZ = 'Europe/Berlin';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ME = null;          // { user, settings, vapidKey, serverNow }
let offset = 0;         // Serverzeit − Gerätezeit
const now = () => Date.now() + offset;
let current = null;     // geöffneter Monat { id, data, json }
let pollTimer = null;
let adminCache = null;

// ------------------------------------------------------------ Hilfen
async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch { /* leer */ }
  if (res.status === 401 && !url.startsWith('/api/login')) {
    if (ME) ME.user = null;
    if (!location.hash.startsWith('#/register')) location.hash = '#/login';
    throw new Error(data.error || 'Bitte anmelden.');
  }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 5000 : 2600);
}
const pad = (n) => String(n).padStart(2, '0');
const num = (x) => Number(x).toLocaleString('de-DE', { maximumFractionDigits: 2 });
const fmtDT = (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
const fmtDay = (d, wd = 'long') => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { timeZone: 'UTC', weekday: wd, day: '2-digit', month: '2-digit' });
const todayBerlin = () => new Date(now()).toLocaleDateString('sv-SE', { timeZone: TZ });
const kindLabel = (k) => (k === 'out' ? ME.settings.outLabel : ME.settings.inLabel);
const kindTime = (k) => (k === 'out' ? ME.settings.outTime : ME.settings.inTime);
const slotLabel = (id) => `${fmtDay(id.slice(0, 10), 'short')} · ${kindLabel(id.slice(11))}`;
function countdown(iso) {
  let s = Math.max(0, Math.floor((Date.parse(iso) - now()) / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return (d ? `${d} ${d === 1 ? 'Tag' : 'Tage'} ` : '') + `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function b64ToU8(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn && btn.isConnected) btn.disabled = false; }
}

// Feiertage Niedersachsen (für den Tage-Editor)
function holidays(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1, E = Date.UTC(y, mo - 1, da), D = 864e5;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return { [`${y}-01-01`]: 'Neujahr', [iso(E - 2 * D)]: 'Karfreitag', [iso(E + D)]: 'Ostermontag', [`${y}-05-01`]: 'Tag der Arbeit', [iso(E + 39 * D)]: 'Christi Himmelfahrt', [iso(E + 50 * D)]: 'Pfingstmontag', [`${y}-10-03`]: 'Tag der Deutschen Einheit', [`${y}-10-31`]: 'Reformationstag', [`${y}-12-25`]: '1. Weihnachtstag', [`${y}-12-26`]: '2. Weihnachtstag' };
}

// ------------------------------------------------------------ Push
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.navigate) location.href = e.data.navigate; });
}
async function pushState() {
  if (!pushSupported) return isIOS && !standalone ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
async function syncSubscription() {
  if (!pushSupported || !ME.user || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) api('POST', '/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(ME.vapidKey) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  toast('Benachrichtigungen sind an ✓');
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  toast('Benachrichtigungen auf diesem Gerät aus.');
}
async function renderPushBox(el, full) {
  if (!el) return;
  const st = await pushState().catch(() => 'unsupported');
  const box = {
    on: full ? `<div class="banner"><b>🔔 Benachrichtigungen sind auf diesem Gerät an.</b>
      <div class="row" style="margin-top:.6rem"><button class="small" data-act="push-test">Test senden</button><button class="small secondary" data-act="push-off">Ausschalten</button></div></div>` : '',
    off: `<div class="banner warn"><b>🔔 Verpass keine Liste mehr</b><p class="small" style="margin:.3rem 0 .6rem">Aktiviere Benachrichtigungen – dann weißt du sofort Bescheid, wenn eine neue Dienstliste kommt und wann die Eintragung startet.</p><button data-act="push-on">Benachrichtigungen aktivieren</button></div>`,
    'ios-install': `<div class="banner warn"><b>🔔 iPhone/iPad: erst zum Home-Bildschirm hinzufügen</b>
      <ol class="steps small"><li>Unten in Safari auf <b>Teilen</b> (Quadrat mit Pfeil) tippen</li><li><b>„Zum Home-Bildschirm“</b> wählen</li><li>Stalldienst über das neue Symbol öffnen, anmelden und hier Benachrichtigungen aktivieren</li></ol></div>`,
    denied: `<div class="banner warn"><b>Benachrichtigungen sind blockiert.</b><p class="small">Bitte in den Browser-/Systemeinstellungen für diese Seite wieder erlauben und die Seite neu laden.</p></div>`,
    unsupported: full ? `<div class="banner gray small">Dieser Browser unterstützt keine Push-Benachrichtigungen. Mit Chrome/Firefox (Android, PC) oder als Home-Bildschirm-App auf dem iPhone (ab iOS 16.4) klappt es.</div>` : '',
  }[st];
  el.innerHTML = box || '';
}

// ------------------------------------------------------------ Router
async function loadMe() {
  ME = await api('GET', '/api/me');
  offset = Date.parse(ME.serverNow) - Date.now();
  $('#stable-name').textContent = ME.settings.stableName;
  document.title = `Stalldienst · ${ME.settings.stableName}`;
}
function renderNav(hash) {
  const u = ME && ME.user;
  const link = (h, t) => `<a href="#${h}" class="${hash === h || (h !== '/' && hash.startsWith(h)) ? 'active' : ''}">${t}</a>`;
  $('#nav').innerHTML = u ? link('/', 'Dienste') + (u.isAdmin ? link('/admin', 'Admin') : '') + link('/konto', 'Konto') : '';
}
async function router() {
  clearTimeout(pollTimer);
  current = null;
  app.onchange = null;
  if (modal.open) modal.close();
  const hash = location.hash.slice(1) || '/';
  const path = hash.split('?')[0];
  try {
    if (!ME) await loadMe();
    renderNav(path);
    if (!ME.user && path !== '/login' && path !== '/register') { location.hash = '#/login'; return; }
    window.scrollTo(0, 0);
    let m;
    if (path === '/login') return viewLogin();
    if (path === '/register') return viewRegister(new URLSearchParams(hash.split('?')[1] || ''));
    if ((m = path.match(/^\/m\/(\d{4}-\d{2})$/))) return await viewMonth(m[1]);
    if ((m = path.match(/^\/admin\/m\/(\d{4}-\d{2})$/))) return await viewAdminMonth(m[1]);
    if (path === '/admin') return await viewAdmin();
    if (path === '/konto') return await viewAccount();
    return await viewHome();
  } catch (e) {
    app.innerHTML = `<div class="card error">${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', router);
document.addEventListener('visibilitychange', () => { if (!document.hidden && current) refreshMonth(true).catch(() => {}); });

// ------------------------------------------------------------ Anmelden / Registrieren
function viewLogin() {
  app.innerHTML = `
    <h1>Anmelden</h1>
    <form class="card" id="f">
      <label for="u">Benutzername</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required>
      <label for="p">Passwort</label><input id="p" name="password" type="password" autocomplete="current-password" required>
      <p class="error" id="err"></p>
      <button>Anmelden</button>
    </form>
    <p class="center">Neu im Stall? <a href="#/register">Konto anlegen</a></p>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    busy(e.submitter, async () => {
      try { await api('POST', '/api/login', fd); } catch (err) { $('#err').textContent = err.message; return; }
      await loadMe(); syncSubscription(); location.hash = '#/';
    });
  };
}
function viewRegister(params) {
  app.innerHTML = `
    <h1>Konto anlegen</h1>
    <form class="card" id="f">
      <label for="n">Dein Name (so sehen dich die anderen)</label><input id="n" name="name" required maxlength="60" placeholder="z. B. Sabine M.">
      <label for="h">Wie viele eigene Pferde stehen im Stall?</label><input id="h" name="horses" type="number" min="0" max="20" value="1" required>
      <label for="u">Benutzername</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required pattern="[a-zA-Z0-9._\\-]{3,40}">
      <p class="hint">Mind. 3 Zeichen, nur Buchstaben, Zahlen, Punkt, Strich.</p>
      <label for="p">Passwort</label><input id="p" name="password" type="password" autocomplete="new-password" minlength="6" required>
      <label for="c">Stall-Code</label><input id="c" name="invite" required value="${esc(params.get('code') || '')}" autocapitalize="characters">
      <p class="hint">Hängt im Stall aus oder bekommst du vom Admin.</p>
      <p class="error" id="err"></p>
      <button>Konto anlegen</button>
    </form>
    <p class="center"><a href="#/login">Ich habe schon ein Konto</a></p>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    busy(e.submitter, async () => {
      try { await api('POST', '/api/register', fd); } catch (err) { $('#err').textContent = err.message; return; }
      await loadMe(); toast(`Willkommen, ${ME.user.name}!`); location.hash = '#/';
    });
  };
}

// ------------------------------------------------------------ Start
const PHASE = {
  draft: ['Entwurf', ''], waiting: ['Startet bald', 'leather'], wishing: ['Wunschphase', 'leather'],
  open: ['Offen', 'green'], closed: ['Abgeschlossen', ''],
};
const modeName = (m) => (m === 'lottery' ? 'Losverfahren' : 'Gleichzeitiger Start');
async function viewHome() {
  const { months } = await api('GET', '/api/months');
  app.innerHTML = `
    <h1>Hallo ${esc(ME.user.name)}</h1>
    <div id="pushbox"></div>
    ${months.length ? months.map(monthCard).join('') : '<div class="card muted">Noch keine Dienstliste veröffentlicht. Sobald es losgeht, bekommst du Bescheid.</div>'}`;
  renderPushBox($('#pushbox'), false);
  syncSubscription();
}
function monthCard(m) {
  const [ph, cls] = PHASE[m.phase];
  const pct = m.myQuota ? Math.min(100, (m.myCount / m.myQuota) * 100) : 0;
  const when = m.phase === 'waiting' ? `Eintragung startet ${fmtDT(m.openAt)}`
    : m.phase === 'wishing' ? `Wünsche bis ${fmtDT(m.openAt)}`
    : m.phase === 'open' ? `${m.totalServices - m.filled} von ${m.totalServices} Plätzen frei` : '';
  return `<a class="month-link" href="#/m/${m.id}"><div class="card">
    <div class="row spread"><h3 style="margin:0">${esc(m.name)}</h3><span class="row"><span class="badge">${modeName(m.mode)}</span><span class="badge ${cls}">${ph}</span></span></div>
    <p class="small muted" style="margin:.35rem 0">${when}</p>
    <div class="row spread small"><span>Deine Dienste</span><b>${m.myCount} / ${m.myQuota}</b></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
  </div></a>`;
}

// ------------------------------------------------------------ Monatsansicht
async function viewMonth(id) {
  current = { id, data: null, json: '' };
  app.innerHTML = '<p class="muted center">Lädt …</p>';
  await refreshMonth(true);
  syncSubscription();
}
async function refreshMonth(force) {
  if (!current) return;
  const id = current.id;
  const { month } = await api('GET', `/api/months/${id}`);
  if (!current || current.id !== id) return;
  const json = JSON.stringify(month);
  if (force || json !== current.json) {
    current.data = month; current.json = json;
    if (!modal.open) renderMonth();
  }
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!current || !current.data) return;
  const m = current.data;
  let ms = 30000;
  if (m.phase === 'open') ms = 5000;
  else if ((m.phase === 'waiting' || m.phase === 'wishing') && Date.parse(m.openAt) - now() < 180000) ms = 3000;
  pollTimer = setTimeout(() => refreshMonth(false).catch(() => schedulePoll()), ms);
}
function setMonth(month) {
  current.data = month; current.json = JSON.stringify(month);
  renderMonth();
}

function renderMonth() {
  const m = current.data;
  const wishIdx = new Map(m.myWishes.map((w, i) => [w.s, i]));
  const y = window.scrollY;
  app.innerHTML = `
    <div class="row spread"><h1 style="margin:0">${esc(m.name)}</h1><span class="badge">${modeName(m.mode)}</span></div>
    ${phaseBanner(m)}
    ${myBar(m)}
    ${m.phase === 'wishing' ? wishPanel(m) : ''}
    <div class="row no-print" style="margin:.5rem 0">
      <button class="secondary small" data-act="print">Drucken / Aushang</button>
      ${ME.user.isAdmin ? `<a class="btn secondary small" href="#/admin/m/${m.id}">Liste verwalten</a>` : ''}
      ${ME.user.isAdmin && m.phase !== 'draft' ? '<span class="small muted">Admin: Namen antippen zum Ändern</span>' : ''}
    </div>
    <div class="print-only"><h2>${esc(ME.settings.stableName)} – Wochenend-/Feiertagsdienste ${esc(m.name)}</h2></div>
    ${m.days.map((d) => dayCard(m, d, wishIdx)).join('')}
    ${peopleTable(m)}
    ${lotteryDetails(m)}
    ${howItWorks(m)}`;
  window.scrollTo(0, y);
  tickCountdowns();
}

function phaseBanner(m) {
  const free = `${m.totalServices - m.filled} von ${m.totalServices} Plätzen frei`;
  switch (m.phase) {
    case 'draft': return '<div class="banner gray"><b>Entwurf</b> – nur Admins sehen diese Liste. Veröffentlichen unter „Liste verwalten“.</div>';
    case 'waiting': return `<div class="banner warn">Eintragung startet in<strong class="big" data-cd="${m.openAt}">${countdown(m.openAt)}</strong>
      <span class="small">${fmtDT(m.openAt)} – für alle gleichzeitig. Kurz vorher und zum Start kommt eine Benachrichtigung. Vorher kann sich niemand eintragen.
      ${m.roundHours > 0 ? `<br>In den ersten ${num(m.roundHours)} Std. darf jede Person höchstens <b>${m.roundLimit}</b> Dienste nehmen, danach bis zum eigenen Soll.` : ''}</span></div>`;
    case 'wishing': return `<div class="banner warn">Wunschphase – Auslosung in<strong class="big" data-cd="${m.openAt}">${countdown(m.openAt)}</strong>
      <span class="small">Wünsche bis ${fmtDT(m.openAt)}. Danach lost das System die Reihenfolge aus und verteilt automatisch. <b>Es ist egal, wann du deine Wünsche abgibst</b> – nur die Reihenfolge deiner Wünsche zählt.</span></div>`;
    case 'open':
      if (m.mode === 'lottery') return `<div class="banner"><b>Ausgelost am ${fmtDT(m.lottery.at)}.</b> <span class="small">Restplätze kann sich jetzt jede:r bis zum eigenen Soll nehmen. ${free}.</span></div>`;
      return `<div class="banner"><b>Eintragung offen.</b> <span class="small">${free}.${m.roundActive ? ` Runde 1 läuft noch bis ${fmtDT(m.roundEndsAt)}: max. <b>${m.roundLimit}</b> Dienste pro Person.` : ''}</span></div>`;
    case 'closed': return `<div class="banner gray"><b>Abgeschlossen.</b> <span class="small">Änderungen bitte über den Admin.</span></div>`;
  }
  return '';
}
function myBar(m) {
  const u = ME.user;
  const pct = m.myQuota ? Math.min(100, (m.myCount / m.myQuota) * 100) : 0;
  return `<div class="card tight">
    <div class="row spread"><span>Dein Soll: <b>${m.myQuota}</b> Dienste <span class="muted small">(${u.horses} ${u.horses === 1 ? 'Pferd' : 'Pferde'} × ${num(m.perHorse)}, aufgerundet)</span></span><b>${m.myCount} / ${m.myQuota}</b></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    ${u.horses === 0 ? '<p class="small error" style="margin:.3rem 0 0">Bei dir sind 0 Pferde hinterlegt – bitte dem Admin Bescheid geben.</p>' : ''}
  </div>`;
}
function wishPanel(m) {
  const n = m.myWishes.length;
  return `<div class="card">
    <h3>Deine Wünsche (${n})</h3>
    <p class="hint">Oben = am wichtigsten. Gib ruhig mehr an als dein Soll von <b>${m.myQuota}</b> (Empfehlung: mind. ${m.myQuota + 3}). Ist ein Termin schon an jemanden vor dir gegangen, kommt dein nächster Wunsch dran. Du bekommst nie mehr als dein Soll.<br>
    <b>Doppeldienst:</b> Wünsch einen Dienst zweimal („+ 2. Platz“). Den 2. Platz bekommst du, wenn er frei bleibt oder die andere Person stattdessen einen ihrer anderen Wünsche bekommen kann.</p>
    <ol class="wishlist">${m.myWishes.map((w, i) => `<li>
      <span class="t">${slotLabel(w.s)}${w.rep ? ' <b class="small" style="color:var(--leather)">· 2. Platz (Doppeldienst)</b>' : ''}</span>
      <button type="button" class="ghost" data-act="wish-move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="hoch">↑</button>
      <button type="button" class="ghost" data-act="wish-move" data-i="${i}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} aria-label="runter">↓</button>
      <button type="button" class="ghost" data-act="wish-del" data-i="${i}" aria-label="entfernen">✕</button></li>`).join('')}</ol>
    ${n === 0 ? '<p class="muted small">Tippe unten bei den Terminen auf „+ Wunsch“.</p>' : ''}
  </div>`;
}
function dayCard(m, d, wishIdx) {
  const past = d.date < todayBerlin();
  const me = ME.user;
  const slots = d.slots.map((s) => {
    const mine = s.places.some((p) => p && p.u === me.id);
    const free = s.places.filter((p) => !p).length;
    const places = s.places.map((p, i) => {
      const edit = me.isAdmin && m.phase !== 'draft' ? ` edit" data-act="admin-edit" data-slot="${s.id}" data-place="${i}` : '';
      if (!p) return `<span class="place free${edit}">frei</span>`;
      return `<span class="place${p.u === me.id ? ' mine' : ''}${p.g ? ' guest' : ''}${edit}">${esc(p.name)}</span>`;
    }).join('');
    let actions = '';
    if (m.phase === 'open' && !past) {
      if (mine) actions = `<button class="small secondary" data-act="release" data-slot="${s.id}">Austragen</button>`;
      else if (free) actions = `<button class="small" data-act="take" data-slot="${s.id}">Eintragen</button>` +
        (free === 2 ? `<button class="small secondary" data-act="take2" data-slot="${s.id}" title="Beide Plätze = 2 Dienste">Allein (2)</button>` : '');
    } else if (m.phase === 'wishing' && free) {
      const nums = m.myWishes.map((w, i) => (w.s === s.id ? i + 1 : 0)).filter(Boolean);
      if (!nums.length) actions = `<button class="small secondary" data-act="wish-add" data-slot="${s.id}">+ Wunsch</button>`;
      else {
        actions = `<button class="small wish-mark" data-act="wish-clear" data-slot="${s.id}" title="Wunsch entfernen">★ Wunsch ${nums.join(' + ')}${nums.length === 2 ? ' (doppelt)' : ''}</button>`;
        if (nums.length === 1 && free === 2) actions += `<button class="small secondary" data-act="wish-add" data-slot="${s.id}" title="Diesen Dienst allein machen (2 Dienste)">+ 2. Platz</button>`;
      }
    }
    return `<div class="slot"><div class="kind"><b>${esc(kindLabel(s.kind))}</b><span>${esc(kindTime(s.kind))}</span></div>
      <div class="places">${places}<span class="slot-actions no-print">${actions}</span></div></div>`;
  }).join('');
  return `<div class="day${past ? ' past' : ''}"><div class="day-head"><b>${fmtDay(d.date)}</b><span class="note">${esc(d.note)}</span></div>${slots}</div>`;
}
function peopleTable(m) {
  const guestRows = Object.entries(m.guests).map(([g, n]) => `<tr><td><i>${esc(g)}</i></td><td class="num">–</td><td class="num">${n}</td><td class="num">–</td>${m.phase === 'wishing' ? '<td></td>' : ''}</tr>`).join('');
  return `<details><summary>Übersicht: wer hat wie viele Dienste</summary>
    <p class="small muted">${m.days.length} Tage × 2 Dienste (${esc(ME.settings.outLabel)}/${esc(ME.settings.inLabel)}) × 2 Plätze = ${m.totalServices} Dienste ÷ ${m.totalHorses} Pferde = ${num(m.perHorse)} pro Pferd.</p>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th class="num">Pferde</th><th class="num">Dienste</th><th class="num">Soll</th>${m.phase === 'wishing' ? '<th>Wünsche</th>' : ''}</tr></thead><tbody>
    ${m.people.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.horses}</td><td class="num">${p.count}</td><td class="num">${p.quota}</td>${m.phase === 'wishing' ? `<td>${p.wished ? '✓' : '–'}</td>` : ''}</tr>`).join('')}
    ${guestRows}</tbody></table></div></details>`;
}
function lotteryDetails(m) {
  if (!m.lottery) return '';
  const L = m.lottery.log;
  const rounds = {};
  L.filter((l) => l.p === 1).forEach((l) => (rounds[l.r] = rounds[l.r] || []).push(l));
  const dbl = L.filter((l) => l.p === 2);
  const late = L.filter((l) => l.p === 3);
  return `<details><summary>Auslosung: Reihenfolge & Protokoll</summary>
    <p class="small muted">Ausgelost am ${fmtDT(m.lottery.at)}. Runde 1 in dieser Reihenfolge, Runde 2 rückwärts, Runde 3 wieder vorwärts usw.</p>
    <ol>${m.lottery.order.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>
    ${Object.entries(rounds).map(([r, list]) => `<p class="small"><b>Runde ${r}:</b> ${list.map((l) => `${esc(l.name)} → ${slotLabel(l.s)}`).join(' · ')}</p>`).join('')}
    ${dbl.length ? `<p class="small"><b>Doppeldienste:</b> ${dbl.map((l) => `${esc(l.name)} → ${slotLabel(l.s)} allein${l.moved ? ` (${esc(l.moved.name)} bekommt dafür ${slotLabel(l.moved.to)})` : ''}${l.dropped ? ` (gibt dafür ${slotLabel(l.dropped)} frei)` : ''}`).join(' · ')}</p>` : ''}
    ${late.length ? `<p class="small"><b>Nachrunde:</b> ${late.map((l) => `${esc(l.name)} → ${slotLabel(l.s)}`).join(' · ')}</p>` : ''}
  </details>`;
}
function howItWorks(m) {
  const body = m.mode === 'lottery'
    ? `<ol class="steps small">
        <li>Die Liste wird veröffentlicht, alle bekommen eine Benachrichtigung.</li>
        <li>Bis zum Stichtag trägt jede:r Wunschtermine in Reihenfolge ein. Wann du das machst, ist egal.</li>
        <li>Zum Stichtag lost das System eine zufällige Reihenfolge aus allen mit Wünschen.</li>
        <li>Verteilt wird reihum im Schlangenprinzip: Runde 1 vorwärts, Runde 2 rückwärts usw. – wer in Runde 1 zuletzt dran war, ist in Runde 2 zuerst dran. Pro Zug gibt es den obersten noch freien Wunsch.</li>
        <li>Danach kommen die Doppeldienste dran (Dienst zweimal gewünscht): Den 2. Platz gibt es, wenn er frei ist oder die Person dort stattdessen einen ihrer anderen Wünsche bekommen kann. Wer denselben Dienst selbst doppelt wollte, wird nicht verdrängt.</li>
        <li>Niemand bekommt mehr als sein Soll. Ist es voll, wird für den Doppeldienst dein unwichtigster Wunsch wieder frei und geht in einer Nachrunde an die anderen.</li>
        <li>Was übrig bleibt, ist danach frei für alle (bis zum eigenen Soll). Reihenfolge und Protokoll sind für alle einsehbar.</li></ol>`
    : `<ol class="steps small">
        <li>Die Liste wird vorab veröffentlicht – mit festem Startzeitpunkt. Alle bekommen sofort eine Benachrichtigung, 30 Minuten vorher eine Erinnerung und zum Start noch eine.</li>
        <li>Vor dem Start kann sich niemand eintragen, auch der Admin nicht über die normale Eintragung.</li>
        <li>Ab Start gilt: wer zuerst tippt, bekommt den Platz. Der Server entscheidet sekundengenau, doppelt vergeben geht nicht.</li>
        <li>Runde 1: Für eine festgelegte Zeit darf jede Person nur wenige Dienste nehmen. So kann sich niemand alle guten Termine auf einmal sichern.</li>
        <li>Danach bis zum eigenen Soll. Mehr als das Soll geht nicht – die Plätze bleiben für die anderen.</li></ol>`;
  return `<details><summary>So funktioniert's</summary>${body}</details>`;
}

// ------------------------------------------------------------ Aktionen (Klicks)
const actions = {
  'push-on': (b) => busy(b, async () => { await enablePush(); renderPushBox(b.closest('#pushbox'), location.hash === '#/konto'); }),
  'push-off': (b) => busy(b, async () => { await disablePush(); renderPushBox(b.closest('#pushbox'), true); }),
  'push-test': (b) => busy(b, async () => { const r = await api('POST', '/api/push/test'); toast(r.sent ? 'Test verschickt – kommt gleich an.' : 'Kein Gerät erreicht. Bitte aus- und wieder einschalten.', !r.sent); }),
  print: () => window.print(),
  take: (b) => busy(b, async () => { setMonth((await api('POST', `/api/months/${current.id}/take`, { slot: b.dataset.slot })).month); toast('Eingetragen ✓'); }),
  take2: (b) => busy(b, async () => { setMonth((await api('POST', `/api/months/${current.id}/take`, { slot: b.dataset.slot, double: true })).month); toast('Allein eingetragen (2 Dienste) ✓'); }),
  release: (b) => {
    if (!confirm(`Aus „${slotLabel(b.dataset.slot)}“ austragen?`)) return;
    busy(b, async () => { setMonth((await api('POST', `/api/months/${current.id}/release`, { slot: b.dataset.slot })).month); toast('Ausgetragen.'); });
  },
  'wish-add': (b) => saveWishes(b, [...current.data.myWishes, { s: b.dataset.slot }]),
  'wish-clear': (b) => saveWishes(b, current.data.myWishes.filter((w) => w.s !== b.dataset.slot)),
  'wish-move': (b) => {
    const list = [...current.data.myWishes], i = Number(b.dataset.i), j = i + Number(b.dataset.dir);
    [list[i], list[j]] = [list[j], list[i]];
    saveWishes(b, list);
  },
  'wish-del': (b) => { const list = [...current.data.myWishes]; list.splice(Number(b.dataset.i), 1); saveWishes(b, list); },
  'admin-edit': (b) => openAssignModal(b.dataset.slot, Number(b.dataset.place)),
};
function saveWishes(btn, wishes) {
  return busy(btn, async () => setMonth((await api('PUT', `/api/months/${current.id}/wishes`, { wishes: wishes.map((w) => ({ s: w.s })) })).month));
}
app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && actions[b.dataset.act]) { if (b.tagName !== 'INPUT') e.preventDefault(); actions[b.dataset.act](b, e); }
});

function tickCountdowns() {
  document.querySelectorAll('[data-cd]').forEach((el) => {
    el.textContent = countdown(el.dataset.cd);
    if (Date.parse(el.dataset.cd) - now() <= 0 && !el.dataset.fired) {
      el.dataset.fired = '1';
      setTimeout(() => refreshMonth(true).catch(() => {}), 700);
    }
  });
}
setInterval(tickCountdowns, 1000);

// ------------------------------------------------------------ Admin: Platz bearbeiten
async function openAssignModal(slot, place) {
  if (!adminCache) adminCache = await api('GET', '/api/admin/overview');
  const cur = current.data.days.flatMap((d) => d.slots).find((s) => s.id === slot).places[place];
  modal.innerHTML = `<form id="af">
    <h3>${slotLabel(slot)} – Platz ${place + 1}</h3>
    <label>Mitglied</label>
    <select name="userId"><option value="">— niemand / Name ohne Konto —</option>
      ${adminCache.users.map((u) => `<option value="${u.id}" ${cur && cur.u === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
    <label>oder Name ohne Konto</label>
    <input name="guest" value="${cur && cur.g ? esc(cur.name) : ''}" placeholder="z. B. Hofteam">
    <p class="hint">Admins können immer eintragen – auch außerhalb der Phasen und über das Soll hinaus (z. B. Tausch, Leute ohne Handy).</p>
    <div class="row" style="margin-top:1rem"><button value="save">Speichern</button><button value="clear" class="danger" type="submit">Leeren</button><button value="cancel" class="secondary" type="submit">Abbrechen</button></div>
  </form>`;
  modal.showModal();
  $('#af').onsubmit = async (e) => {
    e.preventDefault();
    const v = e.submitter && e.submitter.value;
    if (v === 'cancel') return modal.close();
    const fd = Object.fromEntries(new FormData(e.target));
    const body = v === 'clear' ? { slot, place } : { slot, place, userId: fd.userId || undefined, guest: fd.userId ? '' : fd.guest };
    await busy(e.submitter, async () => { const r = await api('POST', `/api/admin/months/${current.id}/assign`, body); modal.close(); setMonth(r.month); });
  };
}
modal.addEventListener('close', () => { if (current && current.data) renderMonth(); });

// ------------------------------------------------------------ Konto
async function viewAccount() {
  const u = ME.user;
  app.innerHTML = `
    <h1>Konto</h1>
    <div class="card"><b>${esc(u.name)}</b> <span class="muted">(@${esc(u.username)})</span><br>
      <span class="small">${u.horses} ${u.horses === 1 ? 'Pferd' : 'Pferde'} hinterlegt${u.isAdmin ? ' · Admin' : ''}. Pferdeanzahl falsch? Bitte dem Admin sagen.</span></div>
    <h2>Benachrichtigungen</h2>
    <div id="pushbox"></div>
    <p class="hint">Benachrichtigungen gelten pro Gerät. Auf jedem Handy/Tablet einmal aktivieren.</p>
    <h2>Passwort ändern</h2>
    <form class="card" id="pf">
      <label>Altes Passwort</label><input type="password" name="old" autocomplete="current-password" required>
      <label>Neues Passwort</label><input type="password" name="password" minlength="6" autocomplete="new-password" required>
      <button style="margin-top:.8rem">Ändern</button>
    </form>
    <button class="secondary" id="logout">Abmelden</button>`;
  renderPushBox($('#pushbox'), true);
  $('#pf').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => { await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('Passwort geändert ✓'); });
  };
  $('#logout').onclick = async () => { await api('POST', '/api/logout'); ME.user = null; location.hash = '#/login'; };
}

// ------------------------------------------------------------ Admin
function nextMonthId() {
  const d = new Date(now()); d.setDate(1); d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
async function viewAdmin() {
  const [ov, { months }] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', '/api/months')]);
  adminCache = ov;
  const s = ov.settings;
  const invite = `${location.origin}/#/register?code=${encodeURIComponent(s.inviteCode)}`;
  app.innerHTML = `
    <h1>Admin</h1>
    <h2>Dienstlisten</h2>
    <form class="card row" id="mf"><input type="month" name="id" value="${nextMonthId()}" required style="max-width:12rem"><button>Neue Liste anlegen</button></form>
    ${months.map((m) => `<div class="card tight row spread"><span><b>${esc(m.name)}</b> <span class="badge">${modeName(m.mode)}</span> <span class="badge ${PHASE[m.phase][1]}">${PHASE[m.phase][0]}</span><br>
      <span class="small muted">${m.filled}/${m.totalServices} Plätze belegt</span></span>
      <span class="row"><a class="btn secondary small" href="#/m/${m.id}">Ansehen</a><a class="btn small" href="#/admin/m/${m.id}">Verwalten</a></span></div>`).join('') || '<p class="muted">Noch keine Listen.</p>'}

    <h2>Mitglieder (${ov.users.length})</h2>
    <div class="card">
      <b>Einladungslink</b> <span class="small muted">(Stall-Code: <b>${esc(s.inviteCode)}</b>)</span>
      <div class="row" style="margin-top:.4rem"><input readonly value="${esc(invite)}" class="grow" id="inv"><button class="small secondary" id="copy">Kopieren</button></div>
      <p class="hint">In die WhatsApp-Gruppe schicken oder als QR-Code im Stall aushängen.</p>
    </div>
    <div class="card table-wrap"><table><thead><tr><th>Name</th><th class="num">Pferde</th><th>Admin</th><th class="num">Push</th><th></th></tr></thead><tbody>
      ${ov.users.map((u) => `<tr><td>${esc(u.name)}<br><span class="small muted">@${esc(u.username)}</span></td>
        <td class="num"><input type="number" min="0" max="20" value="${u.horses}" data-chg="horses" data-id="${u.id}" style="width:4.5rem"></td>
        <td><input type="checkbox" data-chg="admin" data-id="${u.id}" ${u.isAdmin ? 'checked' : ''}></td>
        <td class="num">${u.push ? `${u.push} 🔔` : '–'}</td>
        <td><button class="ghost small" data-adm="pw" data-id="${u.id}">Passwort</button><button class="ghost small" data-adm="del" data-id="${u.id}" data-name="${esc(u.name)}">Löschen</button></td></tr>`).join('')}
    </tbody></table>
    <p class="hint">Registriert: ${ov.registeredHorses} Pferde. „Push“ = Geräte mit aktiven Benachrichtigungen.</p></div>

    <h2>Einstellungen</h2>
    <form class="card" id="sf">
      <label>Name des Stalls</label><input name="stableName" value="${esc(s.stableName)}">
      <label>Pferde im Stall insgesamt</label><input type="number" name="totalHorses" min="1" value="${s.totalHorses}">
      <p class="hint">Alle eingestellten Pferde – auch von Leuten ohne Konto. Grundlage für das Soll: Dienste im Monat ÷ Pferde insgesamt × eigene Pferde.</p>
      <div class="row"><div class="grow"><label>Dienst 1</label><input name="outLabel" value="${esc(s.outLabel)}"></div><div class="grow"><label>Uhrzeit</label><input name="outTime" value="${esc(s.outTime)}"></div></div>
      <div class="row"><div class="grow"><label>Dienst 2</label><input name="inLabel" value="${esc(s.inLabel)}"></div><div class="grow"><label>Uhrzeit</label><input name="inTime" value="${esc(s.inTime)}"></div></div>
      <label>Selbst austragen bis … Tage vor dem Dienst</label><input type="number" name="lockDays" min="0" max="14" value="${s.lockDays}">
      <label>Stall-Code für die Registrierung</label><input name="inviteCode" value="${esc(s.inviteCode)}">
      <button style="margin-top:.8rem">Speichern</button>
    </form>

    <h2>Nachricht an alle</h2>
    <form class="card" id="bf">
      <label>Titel</label><input name="title" placeholder="${esc(s.stableName)}">
      <label>Text</label><textarea name="body" rows="3" required placeholder="z. B. Am Samstag bleiben die Pferde wegen Sturm drin."></textarea>
      <button style="margin-top:.8rem">Push an alle senden</button>
    </form>`;

  $('#copy').onclick = () => { navigator.clipboard.writeText(invite).then(() => toast('Link kopiert ✓'), () => { $('#inv').select(); }); };
  $('#mf').onsubmit = (e) => {
    e.preventDefault();
    const id = new FormData(e.target).get('id');
    busy(e.submitter, async () => { await api('POST', '/api/admin/months', { id }); location.hash = `#/admin/m/${id}`; });
  };
  $('#sf').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => { await api('PUT', '/api/admin/settings', Object.fromEntries(new FormData(e.target))); await loadMe(); toast('Gespeichert ✓'); viewAdmin(); });
  };
  $('#bf').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => { const r = await api('POST', '/api/admin/broadcast', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast(`Verschickt an ${r.sent} Geräte ✓`); });
  };
  app.onchange = (e) => {
    const el = e.target.closest('[data-chg]');
    if (!el) return;
    const body = el.dataset.chg === 'horses' ? { horses: el.value } : { isAdmin: el.checked };
    busy(null, async () => { await api('PUT', `/api/admin/users/${el.dataset.id}`, body); toast('Gespeichert ✓'); if (el.dataset.id === ME.user.id) await loadMe(); });
  };
  app.querySelectorAll('[data-adm]').forEach((b) => (b.onclick = () => {
    if (b.dataset.adm === 'pw') {
      const pw = prompt('Neues Passwort (mind. 6 Zeichen) – bitte der Person mitteilen:');
      if (pw) busy(b, async () => { await api('PUT', `/api/admin/users/${b.dataset.id}`, { password: pw }); toast('Passwort gesetzt ✓'); });
    } else if (confirm(`${b.dataset.name} wirklich löschen?`)) {
      busy(b, async () => { await api('DELETE', `/api/admin/users/${b.dataset.id}`); viewAdmin(); });
    }
  }));
}

async function viewAdminMonth(id) {
  const [{ month: m }, ov] = await Promise.all([api('GET', `/api/months/${id}`), api('GET', '/api/admin/overview')]);
  adminCache = ov;
  const draft = m.status === 'draft';
  const beforeOpen = ['draft', 'waiting', 'wishing'].includes(m.phase);
  const y = Number(id.slice(0, 4)), mo = Number(id.slice(5, 7)) - 1, hol = holidays(y);
  const chosen = new Map(m.days.map((d) => [d.date, d.note]));
  const all = [];
  for (let d = 1; d <= 31; d++) {
    const t = new Date(Date.UTC(y, mo, d));
    if (t.getUTCMonth() !== mo) break;
    const date = t.toISOString().slice(0, 10);
    all.push({ date, we: [0, 6].includes(t.getUTCDay()), hol: hol[date] || '' });
  }
  app.onchange = null;
  app.innerHTML = `
    <div class="row spread"><h1 style="margin:0">Liste ${esc(m.name)}</h1><span class="badge ${PHASE[m.phase][1]}">${PHASE[m.phase][0]}</span></div>
    <p><a href="#/admin">← Admin</a> · <a href="#/m/${m.id}">Liste ansehen${m.phase !== 'draft' ? ' / Einträge ändern' : ''}</a></p>
    <form id="ef">
      <h2>Modus</h2>
      <div class="mode-pick">
        <label><input type="radio" name="mode" value="lottery" ${m.mode === 'lottery' ? 'checked' : ''} ${draft ? '' : 'disabled'}><b>Losverfahren</b><br>
          <span class="small muted">Alle geben bis zu einem Stichtag Wunschtermine in Reihenfolge ab. Dann wird die Reihenfolge ausgelost und reihum verteilt. Niemand muss zur richtigen Zeit online sein. <b>Am fairsten.</b></span></label>
        <label><input type="radio" name="mode" value="fcfs" ${m.mode === 'fcfs' ? 'checked' : ''} ${draft ? '' : 'disabled'}><b>Gleichzeitiger Start</b><br>
          <span class="small muted">Liste ist vorher sichtbar, die Eintragung startet für alle zur selben, angekündigten Minute – mit Push an alle. Ein Limit in Runde 1 verhindert, dass sich jemand alles schnappt.</span></label>
      </div>
      <label id="openLabel"></label>
      <input type="datetime-local" name="openAt" value="${toLocalInput(m.openAt)}" ${beforeOpen ? '' : 'disabled'} required>
      <p class="hint" id="openHint"></p>
      <div id="roundbox" class="row">
        <div class="grow"><label>Runde 1 dauert (Stunden)</label><input type="number" name="roundHours" min="0" max="240" step="1" value="${m.roundHours}"></div>
        <div class="grow"><label>Max. Dienste pro Person in Runde 1</label><input type="number" name="roundLimit" min="1" max="20" value="${m.roundLimit}"></div>
      </div>

      <h2>Diensttage</h2>
      <p class="hint">Wochenenden und Feiertage (Niedersachsen) sind vorausgewählt. Zusätzliche Tage (z. B. Heiligabend, Silvester) einfach anhaken. Pro Tag: ${esc(ME.settings.outLabel)} + ${esc(ME.settings.inLabel)} mit je 2 Plätzen.</p>
      <div class="daypick">${all.map((d) => `<div class="d${chosen.has(d.date) ? ' on' : ''}${d.we || d.hol ? ' we' : ''}">
        <input type="checkbox" name="day" value="${d.date}" ${chosen.has(d.date) ? 'checked' : ''} ${draft ? '' : 'disabled'}>
        <span style="white-space:nowrap">${fmtDay(d.date, 'short')}</span>
        <input type="text" data-note="${d.date}" value="${esc(chosen.get(d.date) ?? d.hol)}" placeholder="Notiz" ${draft ? '' : 'disabled'}></div>`).join('')}</div>
      <div class="banner gray small" id="calc"></div>
      <button>Speichern</button>
    </form>

    <h2>${draft ? 'Veröffentlichen' : 'Status'}</h2>
    <div class="card">
      ${draft ? `<p class="small">Beim Veröffentlichen bekommen alle Mitglieder mit aktivierten Benachrichtigungen sofort eine Push-Nachricht (gerade: <b>${ov.users.filter((u) => u.push).length}</b> von ${ov.users.length}). Modus und Tage sind danach fest.</p>
        <button id="pub">Speichern & veröffentlichen</button>`
      : `<div class="row">${m.status === 'closed' ? '<button class="secondary" id="reopen">Wieder öffnen</button>' : '<button class="secondary" id="close">Abschließen (keine Änderungen mehr durch Mitglieder)</button>'}</div>`}
      <hr style="border:none;border-top:1px solid var(--line);margin:1rem 0">
      <button class="danger small" id="del">Liste löschen</button>
    </div>`;

  const f = $('#ef');
  const update = () => {
    const mode = f.mode.value;
    $('#openLabel').textContent = mode === 'lottery' ? 'Wunschschluss = Zeitpunkt der Auslosung' : 'Start der Eintragung (für alle gleichzeitig)';
    $('#openHint').textContent = mode === 'lottery'
      ? 'Empfehlung: 3–5 Tage nach dem Veröffentlichen, damit wirklich jede:r Zeit hat. 12 Stunden vorher bekommen alle ohne Wünsche eine Erinnerung.'
      : 'Empfehlung: abends (z. B. 20:00 Uhr) und mindestens 1–2 Tage nach dem Veröffentlichen ankündigen. 30 Min. vorher und zum Start kommt eine Benachrichtigung.';
    $('#roundbox').style.display = mode === 'fcfs' ? '' : 'none';
    f.querySelectorAll('.daypick .d').forEach((el) => el.classList.toggle('on', el.querySelector('[name=day]').checked));
    const days = f.querySelectorAll('[name=day]:checked').length;
    const total = days * 4, per = total / ov.settings.totalHorses;
    $('#calc').innerHTML = `<b>${days} Tage → ${total} Dienste</b> ÷ ${ov.settings.totalHorses} Pferde = <b>${num(per)} pro Pferd</b>.
      Soll: 1 Pferd = ${Math.ceil(per - 1e-9)}, 2 Pferde = ${Math.ceil(2 * per - 1e-9)}, 3 Pferde = ${Math.ceil(3 * per - 1e-9)} Dienste.`;
  };
  f.addEventListener('input', update);
  update();

  const collect = () => {
    const body = { roundHours: f.roundHours.value, roundLimit: f.roundLimit.value };
    if (beforeOpen) body.openAt = new Date(f.openAt.value).toISOString();
    if (draft) {
      body.mode = f.mode.value;
      body.days = [...f.querySelectorAll('[name=day]:checked')].map((c) => ({ date: c.value, note: f.querySelector(`[data-note="${c.value}"]`).value }));
    }
    return body;
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => { await api('PUT', `/api/admin/months/${id}`, collect()); toast('Gespeichert ✓'); viewAdminMonth(id); });
  };
  const btn = (sel, fn) => { const b = $(sel); if (b) b.onclick = () => busy(b, fn); };
  btn('#pub', async () => {
    const body = collect();
    const when = fmtDT(body.openAt);
    const text = body.mode === 'lottery' ? `Wunschphase bis ${when}, dann Auslosung.` : `Eintragung startet ${when}.`;
    if (!confirm(`Jetzt veröffentlichen und alle benachrichtigen?\n\n${text}`)) return;
    await api('PUT', `/api/admin/months/${id}`, body);
    const r = await api('POST', `/api/admin/months/${id}/publish`);
    toast(`Veröffentlicht – Push an ${r.sent} Geräte ✓`);
    location.hash = `#/m/${id}`;
  });
  btn('#close', async () => { await api('POST', `/api/admin/months/${id}/close`); viewAdminMonth(id); });
  btn('#reopen', async () => { await api('POST', `/api/admin/months/${id}/close`, { reopen: true }); viewAdminMonth(id); });
  btn('#del', async () => {
    if (!confirm(`Liste ${m.name} mit allen Einträgen endgültig löschen?`)) return;
    await api('DELETE', `/api/admin/months/${id}`);
    location.hash = '#/admin';
  });
}

router();
