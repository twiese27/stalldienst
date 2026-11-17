'use strict';
/*
 * Stalldienst – faire Dienstliste für Wochenend-/Feiertagsdienste im Stall.
 * Keine Abhängigkeiten: läuft mit Node.js >= 18 (`node server.js`).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONTACT = process.env.VAPID_CONTACT || 'mailto:stall@example.org';
const TZ = 'Europe/Berlin';
const REMIND_FCFS_MIN = 30;       // Erinnerung vor Start (Wer zuerst kommt)
const REMIND_LOTTERY_H = 12;      // Erinnerung vor Wunschschluss (Losverfahren)

// ---------------------------------------------------------------- Helpers
const b64u = {
  enc: (b) => Buffer.from(b).toString('base64url'),
  dec: (s) => Buffer.from(s, 'base64url'),
};
const uid = () => crypto.randomBytes(9).toString('base64url');
const todayBerlin = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monthName = (id) => `${MONTHS[Number(id.slice(5, 7)) - 1]} ${id.slice(0, 4)}`;
const fmtDT = (iso) =>
  new Date(iso).toLocaleString('de-DE', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';

function berlinTime(dateStr, hm) {
  for (const off of ['+01:00', '+02:00']) {
    const t = Date.parse(`${dateStr}T${hm}:00${off}`);
    if (new Date(t).toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) === hm) return t;
  }
  return Date.now() + 3 * 86400e3;
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

// ---------------------------------------------------------------- Datenbank (JSON-Datei)
let db;
function genVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), b64u.dec(jwk.x), b64u.dec(jwk.y)]);
  return { publicKey: b64u.enc(pub), privateJwk: jwk };
}
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = null; }
  if (!db) {
    db = {
      settings: {
        stableName: 'Pferdehof Buttersheide',
        inviteCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
        totalHorses: 16,
        outLabel: 'Rausbringen', outTime: '08:00',
        inLabel: 'Reinbringen', inTime: '16:00',
        lockDays: 2,
      },
      users: [], sessions: {}, subs: [], months: [],
    };
  }
  if (!db.settings.vapid) db.settings.vapid = genVapid();
  save();
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}
const userById = (id) => db.users.find((u) => u.id === id);
const monthById = (id) => db.months.find((m) => m.id === id) || fail(404, 'Monat nicht gefunden');

// ---------------------------------------------------------------- Passwörter & Sitzungen
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPw(u, pw) {
  const h = Buffer.from(hashPw(pw, u.salt).hash, 'hex');
  return crypto.timingSafeEqual(h, Buffer.from(u.pwHash, 'hex'));
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function sessionUser(req) {
  const t = parseCookies(req).sid;
  const s = t && db.sessions[t];
  return s ? userById(s.userId) : null;
}
function setSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[token] = { userId, created: new Date().toISOString() };
  save();
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 86400}${secure ? '; Secure' : ''}`);
}

// ---------------------------------------------------------------- Feiertage Niedersachsen
function easterUTC(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
function holidays(y) {
  const e = easterUTC(y), D = 86400000, f = (t) => new Date(t).toISOString().slice(0, 10);
  return {
    [`${y}-01-01`]: 'Neujahr', [f(e - 2 * D)]: 'Karfreitag', [f(e + D)]: 'Ostermontag',
    [`${y}-05-01`]: 'Tag der Arbeit', [f(e + 39 * D)]: 'Christi Himmelfahrt', [f(e + 50 * D)]: 'Pfingstmontag',
    [`${y}-10-03`]: 'Tag der Deutschen Einheit', [`${y}-10-31`]: 'Reformationstag',
    [`${y}-12-25`]: '1. Weihnachtstag', [`${y}-12-26`]: '2. Weihnachtstag',
  };
}
function defaultDays(monthId) {
  const y = Number(monthId.slice(0, 4)), mo = Number(monthId.slice(5, 7)) - 1;
  const hol = holidays(y), out = [];
  for (let d = 1; d <= 31; d++) {
    const t = new Date(Date.UTC(y, mo, d));
    if (t.getUTCMonth() !== mo) break;
    const date = t.toISOString().slice(0, 10), wd = t.getUTCDay();
    if (wd === 0 || wd === 6 || hol[date]) out.push({ date, note: hol[date] || '' });
  }
  return out;
}

// ---------------------------------------------------------------- Dienste, Soll, Phasen
const KINDS = ['out', 'in'];
function syncAssign(m) {
  const next = {};
  for (const d of m.days) for (const k of KINDS) {
    const id = `${d.date}-${k}`;
    next[id] = m.assign[id] || [null, null];
  }
  m.assign = next;
}
function stats(m) {
  const totalServices = m.days.length * KINDS.length * 2;
  const totalHorses = Number(db.settings.totalHorses) || db.users.reduce((s, u) => s + (u.horses || 0), 0) || 1;
  const filled = Object.values(m.assign).flat().filter(Boolean).length;
  return { totalServices, totalHorses, perHorse: totalServices / totalHorses, filled };
}
const quota = (m, u) => Math.ceil(stats(m).perHorse * (u.horses || 0) - 1e-9);
const countFor = (m, id) => Object.values(m.assign).flat().filter((p) => p && p.u === id).length;

function phase(m, now = Date.now()) {
  if (m.status === 'draft') return 'draft';
  if (m.status === 'closed') return 'closed';
  if (now < Date.parse(m.openAt)) return m.mode === 'lottery' ? 'wishing' : 'waiting';
  if (m.mode === 'lottery' && !m.lottery) runLottery(m);
  return 'open';
}

/*
 * Losverfahren
 * Wünsche sind eine geordnete Liste von Plätzen. Ein Dienst darf zweimal gewünscht werden:
 * der zweite Eintrag ist der Wunsch nach dem 2. Platz (= Doppeldienst, man macht ihn allein).
 *
 * 1. Auslosung einer zufälligen Reihenfolge (kryptografischer Zufall).
 * 2. Verteilung im Schlangenprinzip (1→n, n→1, …): pro Zug ein Platz, der oberste noch
 *    freie Wunsch. Zweitplatz-Wünsche werden hier noch übersprungen – erst bekommt jede:r
 *    die normalen Wünsche.
 * 3. Doppeldienste (in Losreihenfolge): Der 2. Platz wird vergeben, wenn er frei ist ODER die
 *    Person auf dem 2. Platz stattdessen einen ihrer anderen Wünsche bekommen kann (sie wird
 *    dann dorthin umgesetzt). Wer selbst denselben Dienst doppelt wollte, wird nicht umgesetzt.
 *    Ist das Soll schon voll, wird dafür der unwichtigste eigene Wunsch (niedriger priorisiert
 *    als der Doppeldienst) wieder freigegeben.
 * 4. Nachrunde im Schlangenprinzip für Plätze, die in Schritt 3 frei geworden sind.
 * Niemand bekommt mehr als sein Soll.
 */
function normWishes(list) {
  const cnt = {}, out = [];
  for (const w of list || []) {
    if (!w || !w.s) continue;
    for (let k = 0; k < (w.d ? 2 : 1); k++) {
      cnt[w.s] = (cnt[w.s] || 0) + 1;
      if (cnt[w.s] <= 2) out.push(w.s);
    }
  }
  return out.map((s, i) => ({ s, rank: i, rep: out.indexOf(s) < i }));
}
function runLottery(m) {
  const W = {};
  for (const u of db.users) { const w = normWishes(m.wishes[u.id]); if (w.length) W[u.id] = w; }
  const order = Object.keys(W);
  for (let i = order.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const holds = (id, s) => m.assign[s].filter((p) => p && p.u === id).length;
  const left = (id) => quota(m, userById(id)) - countFor(m, id);
  const freeIdx = (s) => m.assign[s].indexOf(null);
  const log = [];

  const draft = (pass) => {
    const ptr = Object.fromEntries(order.map((id) => [id, 0]));
    const active = new Set(order.filter((id) => left(id) > 0));
    for (let round = 0; active.size && round < 1000; round++) {
      for (const id of round % 2 === 0 ? order : [...order].reverse()) {
        if (!active.has(id)) continue;
        let got = false;
        while (ptr[id] < W[id].length) {
          const w = W[id][ptr[id]++];
          if (w.rep || !m.assign[w.s] || holds(id, w.s) || freeIdx(w.s) < 0) continue;
          m.assign[w.s][freeIdx(w.s)] = { u: id };
          log.push({ p: pass, r: round + 1, u: id, s: w.s });
          got = true;
          break;
        }
        if (!got || left(id) <= 0) active.delete(id);
      }
    }
  };

  draft(1);

  // Doppeldienste
  for (const id of order) {
    for (const w of W[id].filter((x) => x.rep)) {
      const S = w.s;
      if (!m.assign[S] || holds(id, S) !== 1) continue;
      let dropped = null;
      if (left(id) <= 0) {
        const cand = W[id].filter((x) => !x.rep && x.s !== S && x.rank > w.rank && m.assign[x.s] && holds(id, x.s) === 1 && !W[id].some((y) => y.rep && y.s === x.s));
        if (!cand.length) continue;
        dropped = cand[cand.length - 1].s;
        const k = m.assign[dropped].findIndex((p) => p && p.u === id);
        m.assign[dropped][k] = null;
      }
      const other = m.assign[S].findIndex((p) => !(p && p.u === id));
      const p = m.assign[S][other];
      let ok = !p, moved = null;
      if (p && p.u && W[p.u] && !W[p.u].some((x) => x.rep && x.s === S)) {
        const B = p.u;
        const alt = W[B].find((x) => !x.rep && x.s !== S && m.assign[x.s] && !holds(B, x.s) && freeIdx(x.s) >= 0);
        if (alt) { m.assign[alt.s][freeIdx(alt.s)] = { u: B }; moved = { u: B, to: alt.s }; ok = true; }
      }
      if (ok) {
        m.assign[S][other] = { u: id };
        log.push({ p: 2, u: id, s: S, moved, dropped });
      } else if (dropped) {
        m.assign[dropped][m.assign[dropped].indexOf(null)] = { u: id };
      }
    }
  }

  draft(3);
  m.lottery = { at: new Date().toISOString(), order, log };
  save();
}

// ---------------------------------------------------------------- Web Push (RFC 8291 + VAPID)
function vapidJwt(aud) {
  const h = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u.enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT }));
  const key = crypto.createPrivateKey({ key: db.settings.vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u.enc(sig)}`;
}
function encryptPayload(sub, payload) {
  const uaPublic = b64u.dec(sub.keys.p256dh);
  const authSecret = b64u.dec(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}
async function sendPush(sub, data) {
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(data)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400', Urgency: 'high',
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${vapidJwt(new URL(sub.endpoint).origin)}, k=${db.settings.vapid.publicKey}`,
    },
    body,
  });
  return res.status;
}
async function notify(userIds, data) {
  const targets = db.subs.filter((s) => !userIds || userIds.includes(s.userId));
  let sent = 0;
  await Promise.all(targets.map(async (s) => {
    try {
      const st = await sendPush(s, data);
      if (st === 404 || st === 410) db.subs = db.subs.filter((x) => x.endpoint !== s.endpoint);
      else if (st < 300) sent++;
      else console.warn('Push', st, s.endpoint.slice(0, 60));
    } catch (e) { console.warn('Push-Fehler', e.message); }
  }));
  save();
  return sent;
}

// ---------------------------------------------------------------- Zeitsteuerung
async function tick() {
  const now = Date.now();
  for (const m of db.months) {
    if (m.status !== 'published') continue;
    const open = Date.parse(m.openAt), url = `/#/m/${m.id}`, name = monthName(m.id);
    if (!m.flags.remind) {
      const lead = m.mode === 'lottery' ? REMIND_LOTTERY_H * 3600e3 : REMIND_FCFS_MIN * 60e3;
      if (now >= open - lead && now < open) {
        m.flags.remind = true; save();
        if (m.mode === 'lottery') {
          const missing = db.users.filter((u) => !(m.wishes[u.id] || []).length).map((u) => u.id);
          await notify(missing, { title: `Wünsche für ${name}`, body: `Du hast noch keine Wünsche abgegeben. Schluss: ${fmtDT(m.openAt)}`, url });
        } else {
          await notify(null, { title: `Dienstliste ${name}`, body: `In ${REMIND_FCFS_MIN} Minuten geht die Eintragung los (${fmtDT(m.openAt)}).`, url });
        }
      }
    }
    if (!m.flags.open && now >= open) {
      m.flags.open = true;
      phase(m); // führt ggf. die Auslosung aus
      save();
      if (m.mode === 'lottery') {
        for (const u of db.users) {
          const n = countFor(m, u.id);
          const wished = (m.wishes[u.id] || []).length > 0;
          await notify([u.id], {
            title: `Auslosung ${name}`,
            body: wished ? `Du hast ${n} von ${quota(m, u)} Diensten bekommen. Restplätze sind jetzt frei.` : `Die Auslosung ist durch – Restplätze sind jetzt frei. Dein Soll: ${quota(m, u)}.`,
            url,
          });
        }
      } else {
        await notify(null, { title: `Jetzt eintragen: ${name}`, body: 'Die Dienstliste ist offen. Alle haben ab jetzt die gleiche Chance.', url });
      }
    }
  }
}

// ---------------------------------------------------------------- Ansichten
function publicUser(u) {
  return { id: u.id, name: u.name, username: u.username, horses: u.horses, isAdmin: !!u.isAdmin };
}
function monthSummary(m, u) {
  const st = stats(m);
  return { id: m.id, name: monthName(m.id), mode: m.mode, status: m.status, phase: phase(m), openAt: m.openAt, ...st, myCount: countFor(m, u.id), myQuota: quota(m, u) };
}
function monthView(m, u) {
  const ph = phase(m);
  const nameOf = (id) => (userById(id) || {}).name || '(gelöscht)';
  const place = (p) => (!p ? null : p.u ? { u: p.u, name: nameOf(p.u) } : { g: true, name: p.g });
  const days = m.days.map((d) => ({
    date: d.date, note: d.note,
    slots: KINDS.map((k) => ({ id: `${d.date}-${k}`, kind: k, places: m.assign[`${d.date}-${k}`].map(place) })),
  }));
  const people = db.users
    .filter((x) => x.horses > 0 || countFor(m, x.id))
    .map((x) => ({ id: x.id, name: x.name, horses: x.horses, count: countFor(m, x.id), quota: quota(m, x), wished: (m.wishes[x.id] || []).length > 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const guests = {};
  Object.values(m.assign).flat().forEach((p) => { if (p && p.g) guests[p.g] = (guests[p.g] || 0) + 1; });
  return {
    ...monthSummary(m, u), phase: ph, days, people, guests,
    roundHours: m.roundHours, roundLimit: m.roundLimit,
    roundActive: m.mode === 'fcfs' && ph === 'open' && Date.now() < Date.parse(m.openAt) + m.roundHours * 3600e3,
    roundEndsAt: new Date(Date.parse(m.openAt) + (m.roundHours || 0) * 3600e3).toISOString(),
    myWishes: normWishes(m.wishes[u.id]).map((w) => ({ s: w.s, rep: w.rep })),
    lottery: m.lottery ? { at: m.lottery.at, order: m.lottery.order.map(nameOf), log: m.lottery.log.map((l) => ({ ...l, p: l.p || 1, name: nameOf(l.u), moved: l.moved ? { ...l.moved, name: nameOf(l.moved.u) } : null })) } : null,
    publishedAt: m.publishedAt,
  };
}

// ---------------------------------------------------------------- HTTP
const loginFails = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const rec = (loginFails.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  loginFails.set(ip, rec);
  if (rec.length >= 10) fail(429, 'Zu viele Versuche – bitte 15 Minuten warten.');
  return () => rec.push(now);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 200e3) { reject(new HttpError(413, 'Zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });
const str = (v, max = 100) => String(v ?? '').trim().slice(0, max);
const requireAdmin = (u) => { if (!u.isAdmin) fail(403, 'Nur für Admins'); };

// --- Konto
route('POST', '/api/register', (req, b) => {
  const s = db.settings;
  if (str(b.invite).toUpperCase() !== s.inviteCode.toUpperCase()) fail(400, 'Der Stall-Code stimmt nicht.');
  const username = str(b.username, 40).toLowerCase();
  const name = str(b.name, 60);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) fail(400, 'Benutzername: mind. 3 Zeichen, nur a–z, 0–9, . _ -');
  if (!name) fail(400, 'Bitte deinen Namen angeben.');
  if (String(b.password || '').length < 6) fail(400, 'Passwort: mindestens 6 Zeichen.');
  if (db.users.some((u) => u.username === username)) fail(400, 'Benutzername ist schon vergeben.');
  const horses = Math.max(0, Math.min(20, parseInt(b.horses, 10) || 0));
  const { salt, hash } = hashPw(String(b.password));
  const u = { id: uid(), name, username, horses, salt, pwHash: hash, isAdmin: db.users.length === 0, createdAt: new Date().toISOString() };
  db.users.push(u);
  setSession(req, req.res, u.id);
  return { user: publicUser(u) };
}, { public: true });

route('POST', '/api/login', (req, b) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const markFail = rateLimit(ip);
  const u = db.users.find((x) => x.username === str(b.username, 40).toLowerCase());
  if (!u || !checkPw(u, String(b.password || ''))) { markFail(); fail(400, 'Benutzername oder Passwort falsch.'); }
  setSession(req, req.res, u.id);
  return { user: publicUser(u) };
}, { public: true });

route('POST', '/api/logout', (req) => {
  delete db.sessions[parseCookies(req).sid];
  save();
  req.res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  return { ok: true };
}, { public: true });

route('GET', '/api/me', (req, b, u) => {
  const s = db.settings;
  return {
    user: u ? publicUser(u) : null,
    serverNow: new Date().toISOString(),
    vapidKey: s.vapid.publicKey,
    settings: { stableName: s.stableName, outLabel: s.outLabel, outTime: s.outTime, inLabel: s.inLabel, inTime: s.inTime, lockDays: s.lockDays },
    pushCount: u ? db.subs.filter((x) => x.userId === u.id).length : 0,
  };
}, { public: true });

route('POST', '/api/me/password', (req, b, u) => {
  if (!checkPw(u, String(b.old || ''))) fail(400, 'Altes Passwort stimmt nicht.');
  if (String(b.password || '').length < 6) fail(400, 'Passwort: mindestens 6 Zeichen.');
  Object.assign(u, (({ salt, hash }) => ({ salt, pwHash: hash }))(hashPw(String(b.password))));
  return { ok: true };
});

// --- Push
route('POST', '/api/push/subscribe', (req, b, u) => {
  const s = b.subscription || {};
  if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) fail(400, 'Ungültiges Abo');
  if (!/^https:\/\//.test(s.endpoint)) fail(400, 'Ungültiger Endpunkt');
  db.subs = db.subs.filter((x) => x.endpoint !== s.endpoint);
  db.subs.push({ userId: u.id, endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, created: new Date().toISOString(), ua: str(req.headers['user-agent'], 120) });
  return { ok: true };
});
route('POST', '/api/push/unsubscribe', (req, b, u) => {
  db.subs = db.subs.filter((x) => !(x.userId === u.id && x.endpoint === b.endpoint));
  return { ok: true };
});
route('POST', '/api/push/test', async (req, b, u) => {
  const n = await notify([u.id], { title: 'Test 🐴', body: 'Benachrichtigungen funktionieren auf diesem Gerät.', url: '/' });
  return { sent: n };
});

// --- Monate (Mitglieder)
route('GET', '/api/months', (req, b, u) => ({
  months: db.months.filter((m) => m.status !== 'draft' || u.isAdmin).sort((a, b) => b.id.localeCompare(a.id)).map((m) => monthSummary(m, u)),
}));
const visibleMonth = (id, u) => {
  const m = monthById(id);
  if (m.status === 'draft' && !u.isAdmin) fail(404, 'Monat nicht gefunden');
  return m;
};
route('GET', '/api/months/(\\d{4}-\\d{2})', (req, b, u, [id]) => ({ month: monthView(visibleMonth(id, u), u) }));

route('PUT', '/api/months/(\\d{4}-\\d{2})/wishes', (req, b, u, [id]) => {
  const m = visibleMonth(id, u);
  if (phase(m) !== 'wishing') fail(400, 'Wünsche können gerade nicht geändert werden.');
  const list = normWishes((Array.isArray(b.wishes) ? b.wishes : []).filter((w) => w && m.assign[w.s]))
    .slice(0, 50)
    .map((w) => ({ s: w.s }));
  m.wishes[u.id] = list;
  return { month: monthView(m, u) };
});

function lockedForUser(m, slotId) {
  const date = slotId.slice(0, 10);
  const diff = (Date.parse(date) - Date.parse(todayBerlin())) / 86400000;
  return diff < (Number(db.settings.lockDays) || 0);
}
route('POST', '/api/months/(\\d{4}-\\d{2})/take', (req, b, u, [id]) => {
  const m = visibleMonth(id, u);
  if (phase(m) !== 'open') fail(400, 'Die Eintragung ist (noch) nicht offen.');
  const places = m.assign[b.slot] || fail(404, 'Dienst nicht gefunden');
  if (lockedForUser(m, b.slot)) fail(400, 'Dieser Termin ist zu kurzfristig – bitte beim Admin melden.');
  if (places.some((p) => p && p.u === u.id)) fail(400, 'Du bist hier schon eingetragen.');
  const need = b.double ? 2 : 1;
  const free = places.filter((p) => !p).length;
  if (free < need) fail(409, need === 2 ? 'Für einen Doppeldienst sind nicht mehr beide Plätze frei.' : 'Leider schon vergeben.');
  const have = countFor(m, u.id), q = quota(m, u);
  if (have + need > q) fail(400, `Damit wärst du über deinem Soll von ${q} Diensten. Restliche Plätze bekommen die anderen.`);
  if (m.mode === 'fcfs' && Date.now() < Date.parse(m.openAt) + m.roundHours * 3600e3 && have + need > m.roundLimit)
    fail(400, `Runde 1 läuft noch bis ${fmtDT(new Date(Date.parse(m.openAt) + m.roundHours * 3600e3).toISOString())}: max. ${m.roundLimit} Dienste pro Person. Danach geht's weiter.`);
  for (let i = 0; i < need; i++) places[places.indexOf(null)] = { u: u.id };
  return { month: monthView(m, u) };
});
route('POST', '/api/months/(\\d{4}-\\d{2})/release', (req, b, u, [id]) => {
  const m = visibleMonth(id, u);
  if (m.status !== 'published' || phase(m) !== 'open') fail(400, 'Austragen ist gerade nicht möglich.');
  const places = m.assign[b.slot] || fail(404, 'Dienst nicht gefunden');
  if (lockedForUser(m, b.slot)) fail(400, `Austragen geht nur bis ${db.settings.lockDays} Tage vorher – bitte tauschen und dem Admin Bescheid geben.`);
  m.assign[b.slot] = places.map((p) => (p && p.u === u.id ? null : p));
  return { month: monthView(m, u) };
});

// --- Admin
route('GET', '/api/admin/overview', (req, b, u) => {
  requireAdmin(u);
  const s = db.settings;
  return {
    settings: { stableName: s.stableName, inviteCode: s.inviteCode, totalHorses: s.totalHorses, outLabel: s.outLabel, outTime: s.outTime, inLabel: s.inLabel, inTime: s.inTime, lockDays: s.lockDays },
    users: db.users.map((x) => ({ ...publicUser(x), push: db.subs.filter((p) => p.userId === x.id).length, createdAt: x.createdAt })),
    registeredHorses: db.users.reduce((a, x) => a + (x.horses || 0), 0),
  };
});
route('PUT', '/api/admin/settings', (req, b, u) => {
  requireAdmin(u);
  const s = db.settings;
  if (b.stableName !== undefined) s.stableName = str(b.stableName, 80) || s.stableName;
  if (b.inviteCode !== undefined) s.inviteCode = str(b.inviteCode, 20).toUpperCase() || s.inviteCode;
  if (b.totalHorses !== undefined) s.totalHorses = Math.max(1, parseInt(b.totalHorses, 10) || 1);
  for (const k of ['outLabel', 'inLabel']) if (b[k] !== undefined) s[k] = str(b[k], 30) || s[k];
  for (const k of ['outTime', 'inTime']) if (b[k] !== undefined) s[k] = str(b[k], 20);
  if (b.lockDays !== undefined) s.lockDays = Math.max(0, Math.min(14, parseInt(b.lockDays, 10) || 0));
  return { ok: true };
});
route('PUT', '/api/admin/users/([\\w-]+)', (req, b, u, [id]) => {
  requireAdmin(u);
  const x = userById(id) || fail(404, 'Nutzer nicht gefunden');
  if (b.name !== undefined) x.name = str(b.name, 60) || x.name;
  if (b.horses !== undefined) x.horses = Math.max(0, Math.min(20, parseInt(b.horses, 10) || 0));
  if (b.isAdmin !== undefined) {
    if (x.id === u.id && !b.isAdmin) fail(400, 'Du kannst dir die Admin-Rechte nicht selbst entziehen.');
    x.isAdmin = !!b.isAdmin;
  }
  if (b.password) {
    if (String(b.password).length < 6) fail(400, 'Passwort: mindestens 6 Zeichen.');
    const { salt, hash } = hashPw(String(b.password));
    x.salt = salt; x.pwHash = hash;
    for (const [t, s] of Object.entries(db.sessions)) if (s.userId === x.id) delete db.sessions[t];
  }
  return { ok: true };
});
route('DELETE', '/api/admin/users/([\\w-]+)', (req, b, u, [id]) => {
  requireAdmin(u);
  if (id === u.id) fail(400, 'Du kannst dich nicht selbst löschen.');
  db.users = db.users.filter((x) => x.id !== id);
  db.subs = db.subs.filter((x) => x.userId !== id);
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === id) delete db.sessions[t];
  return { ok: true };
});

route('POST', '/api/admin/months', (req, b, u) => {
  requireAdmin(u);
  const id = str(b.id, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(id)) fail(400, 'Ungültiger Monat');
  if (db.months.some((m) => m.id === id)) fail(400, 'Diesen Monat gibt es schon.');
  const m = {
    id, mode: 'lottery', status: 'draft', days: defaultDays(id), assign: {}, wishes: {},
    openAt: new Date(berlinTime(new Date(Date.now() + 3 * 86400e3).toLocaleDateString('sv-SE', { timeZone: TZ }), '20:00')).toISOString(), roundHours: 24, roundLimit: 2,
    lottery: null, flags: {}, createdAt: new Date().toISOString(),
  };
  syncAssign(m);
  db.months.push(m);
  return { month: monthView(m, u) };
});
route('PUT', '/api/admin/months/(\\d{4}-\\d{2})', (req, b, u, [id]) => {
  requireAdmin(u);
  const m = monthById(id);
  const ph = phase(m);
  if (b.days !== undefined) {
    if (m.status !== 'draft') fail(400, 'Tage können nach dem Veröffentlichen nicht mehr geändert werden.');
    const seen = new Set();
    m.days = (Array.isArray(b.days) ? b.days : [])
      .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date.startsWith(id) && !seen.has(d.date) && seen.add(d.date))
      .map((d) => ({ date: d.date, note: str(d.note, 40) }))
      .sort((a, c) => a.date.localeCompare(c.date));
    syncAssign(m);
  }
  if (b.mode !== undefined) {
    if (m.status !== 'draft') fail(400, 'Der Modus kann nach dem Veröffentlichen nicht mehr geändert werden.');
    m.mode = b.mode === 'fcfs' ? 'fcfs' : 'lottery';
  }
  if (b.openAt !== undefined) {
    if (!['draft', 'waiting', 'wishing'].includes(ph)) fail(400, 'Der Start ist schon vorbei.');
    const t = Date.parse(b.openAt);
    if (!t) fail(400, 'Ungültiger Zeitpunkt');
    m.openAt = new Date(t).toISOString();
    m.flags.remind = false;
  }
  if (b.roundHours !== undefined) m.roundHours = Math.max(0, Math.min(240, Number(b.roundHours) || 0));
  if (b.roundLimit !== undefined) m.roundLimit = Math.max(1, Math.min(20, parseInt(b.roundLimit, 10) || 1));
  return { month: monthView(m, u) };
});
route('POST', '/api/admin/months/(\\d{4}-\\d{2})/publish', async (req, b, u, [id]) => {
  requireAdmin(u);
  const m = monthById(id);
  if (m.status !== 'draft') fail(400, 'Schon veröffentlicht.');
  if (!m.days.length) fail(400, 'Keine Diensttage ausgewählt.');
  const minLead = m.mode === 'lottery' ? 3600e3 : 10 * 60e3;
  if (Date.parse(m.openAt) < Date.now() + minLead)
    fail(400, m.mode === 'lottery' ? 'Wunschschluss muss mindestens 1 Stunde in der Zukunft liegen (besser: 2–4 Tage).' : 'Start muss mindestens 10 Minuten in der Zukunft liegen, damit alle Bescheid bekommen.');
  m.status = 'published';
  m.publishedAt = new Date().toISOString();
  m.flags = { pub: true };
  save();
  const name = monthName(m.id);
  const body = m.mode === 'lottery'
    ? `Wunschliste ist offen bis ${fmtDT(m.openAt)}. Danach wird ausgelost – es zählt nicht, wer zuerst da ist.`
    : `Eintragung startet ${fmtDT(m.openAt)} – für alle gleichzeitig. Du bekommst dann nochmal Bescheid.`;
  const sent = await notify(null, { title: `Neue Dienstliste: ${name}`, body, url: `/#/m/${m.id}` });
  return { month: monthView(m, u), sent };
});
route('POST', '/api/admin/months/(\\d{4}-\\d{2})/close', (req, b, u, [id]) => {
  requireAdmin(u);
  const m = monthById(id);
  m.status = b.reopen ? 'published' : 'closed';
  return { month: monthView(m, u) };
});
route('DELETE', '/api/admin/months/(\\d{4}-\\d{2})', (req, b, u, [id]) => {
  requireAdmin(u);
  db.months = db.months.filter((m) => m.id !== id);
  return { ok: true };
});
route('POST', '/api/admin/months/(\\d{4}-\\d{2})/assign', (req, b, u, [id]) => {
  requireAdmin(u);
  const m = monthById(id);
  const places = m.assign[b.slot] || fail(404, 'Dienst nicht gefunden');
  const i = Number(b.place);
  if (![0, 1].includes(i)) fail(400, 'Ungültiger Platz');
  if (b.userId) { if (!userById(b.userId)) fail(404, 'Nutzer nicht gefunden'); places[i] = { u: b.userId }; }
  else if (str(b.guest)) places[i] = { g: str(b.guest, 40) };
  else places[i] = null;
  return { month: monthView(m, u) };
});
route('POST', '/api/admin/broadcast', async (req, b, u) => {
  requireAdmin(u);
  const title = str(b.title, 80) || db.settings.stableName;
  const body = str(b.body, 300);
  if (!body) fail(400, 'Bitte einen Text eingeben.');
  return { sent: await notify(null, { title, body, url: str(b.url, 100) || '/' }) };
});

// --- Statische Dateien
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let p = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '\\') p = '/index.html';
  let file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
    ...(path.basename(file) === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) fail(415, 'JSON erwartet');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) fail(404, 'Unbekannte Adresse');
    const params = url.pathname.match(r.re).slice(1);
    const body = req.method === 'GET' ? {} : await readBody(req);
    const u = sessionUser(req);
    if (!r.public && !u) fail(401, 'Bitte anmelden.');
    req.res = res;
    const out = await r.handler(req, body, u, params);
    if (req.method !== 'GET') save();
    send(200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Interner Fehler' });
  }
});

if (require.main === module) {
  load();
  setInterval(() => tick().catch((e) => console.error('tick', e)), 15000);
  tick().catch(() => {});
  server.listen(PORT, () => {
    console.log(`Stalldienst läuft auf http://localhost:${PORT}`);
    console.log(`Stall-Code für die Registrierung: ${db.settings.inviteCode}  (wer sich zuerst registriert, wird Admin)`);
  });
}

module.exports = { encryptPayload, runLottery, normWishes, holidays, defaultDays, _db: () => db, _setDb: (d) => { db = d; }, load, phase, quota, stats };
