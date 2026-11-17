'use strict';
// Selbsttest: Push-Verschlüsselung (Entschlüsseln wie ein Browser), Feiertage, Losverfahren.
const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = path.join(os.tmpdir(), 'stalldienst-test-' + Date.now());
const S = require('../server.js');

// 1) Web-Push aes128gcm: verschlüsseln und mit "Browser"-Schlüssel wieder entschlüsseln
{
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const msg = Buffer.from(JSON.stringify({ title: 'Dienstliste Dezember', body: 'Jetzt eintragen – Übermorgen' }));
  const body = S.encryptPayload(sub, msg);
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.strictEqual(rs, 4096); assert.strictEqual(idlen, 65);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2);
  assert.deepStrictEqual(plain.subarray(0, -1), msg);
  console.log('✓ Push-Verschlüsselung (RFC 8291) entschlüsselt korrekt');
}

// 2) Feiertage + Diensttage Dezember 2026 → 36 Dienste, bei 16 Pferden 2,25 pro Pferd
{
  const h = S.holidays(2026);
  assert.strictEqual(h['2026-04-03'], 'Karfreitag');
  assert.strictEqual(h['2026-05-14'], 'Christi Himmelfahrt');
  assert.strictEqual(h['2026-05-25'], 'Pfingstmontag');
  const days = S.defaultDays('2026-12');
  assert.deepStrictEqual(days.map((d) => d.date.slice(8)), ['05', '06', '12', '13', '19', '20', '25', '26', '27']);
  assert.strictEqual(days.length * 4 / 16, 2.25);
  console.log('✓ Dezember 2026: 9 Tage, 36 Dienste, 2,25 pro Pferd (bei 16 Pferden)');
}

// 3) Losverfahren: Soll wird nie überschritten, kein Platz doppelt, Doppelwünsche funktionieren
{
  S.load();
  const db = S._db();
  db.settings.totalHorses = 16;
  const users = [];
  for (let i = 0; i < 10; i++) users.push({ id: 'u' + i, name: 'User ' + i, horses: i < 6 ? 2 : 1 });
  db.users = users;
  const m = { id: '2026-12', mode: 'lottery', status: 'published', days: S.defaultDays('2026-12'), assign: {}, wishes: {}, openAt: new Date(Date.now() - 1000).toISOString(), roundHours: 0, roundLimit: 2, lottery: null, flags: {} };
  for (const d of m.days) for (const k of ['out', 'in']) m.assign[`${d.date}-${k}`] = [null, null];
  db.months = [m];
  const slots = Object.keys(m.assign);
  // Alle wollen bevorzugt die Weihnachtstermine + Samstag früh – maximaler Konflikt
  const popular = ['2026-12-25-out', '2026-12-26-out', '2026-12-05-in', '2026-12-12-in'];
  for (const u of users) {
    const rest = slots.filter((s) => !popular.includes(s)).sort(() => Math.random() - 0.5).slice(0, 8);
    const list = [...popular, ...rest];
    if (u.id === 'u0') list.splice(1, 0, popular[0]); // u0 will 25.12. früh doppelt
    m.wishes[u.id] = list.map((s) => ({ s }));
  }
  assert.strictEqual(S.phase(m), 'open');
  assert.ok(m.lottery && m.lottery.order.length === 10);
  for (const u of users) {
    const n = Object.values(m.assign).flat().filter((p) => p && p.u === u.id).length;
    assert.ok(n <= S.quota(m, u), `${u.id} über Soll`);
  }
  for (const [s, p] of Object.entries(m.assign)) {
    const ids = p.filter(Boolean).map((x) => x.u);
    if (ids.length === 2 && ids[0] === ids[1]) assert.strictEqual(s, popular[0], 'Doppel nur dort, wo gewünscht');
  }
  console.log('✓ Losverfahren: Soll eingehalten, keine Überbelegung, Doppel nur wo gewünscht');
  console.log('  Doppeldienste:', JSON.stringify(m.lottery.log.filter((l) => l.p === 2)));
}

// 4) Gezielter Doppeldienst-Fall: A will 05.12. früh doppelt, B hat dort den 2. Platz, hat aber einen Ausweichwunsch
{
  const db = S._db();
  db.settings.totalHorses = 72; // 0,5 pro Pferd → A (4 Pferde) Soll 2, B (2 Pferde) Soll 1
  db.users = [{ id: 'A', name: 'A', horses: 4 }, { id: 'B', name: 'B', horses: 2 }];
  const mk = () => {
    const m = { id: '2026-12', mode: 'lottery', status: 'published', days: S.defaultDays('2026-12'), assign: {}, wishes: {}, openAt: new Date(Date.now() - 1000).toISOString(), lottery: null, flags: {} };
    for (const d of m.days) for (const k of ['out', 'in']) m.assign[`${d.date}-${k}`] = [null, null];
    db.months = [m];
    return m;
  };
  let m = mk();
  m.wishes = { A: [{ s: '2026-12-05-out' }, { s: '2026-12-05-out' }], B: [{ s: '2026-12-05-out' }, { s: '2026-12-06-out' }] };
  S.phase(m);
  assert.deepStrictEqual(m.assign['2026-12-05-out'].map((p) => p.u), ['A', 'A']);
  assert.ok(m.assign['2026-12-06-out'].some((p) => p && p.u === 'B'));
  console.log('✓ Doppeldienst: B wird auf seinen Ausweichwunsch umgesetzt');

  m = mk();
  m.wishes = { A: [{ s: '2026-12-05-out' }, { s: '2026-12-05-out' }], B: [{ s: '2026-12-05-out' }] };
  S.phase(m);
  assert.deepStrictEqual(m.assign['2026-12-05-out'].map((p) => p.u).sort(), ['A', 'B']);
  console.log('✓ Kein Doppeldienst, wenn B keinen anderen Wunsch hat');

  m = mk();
  m.wishes = { A: [{ s: '2026-12-05-out' }, { s: '2026-12-05-out' }], B: [{ s: '2026-12-05-out' }, { s: '2026-12-05-out' }, { s: '2026-12-06-out' }] };
  S.phase(m);
  assert.deepStrictEqual(m.assign['2026-12-05-out'].map((p) => p.u).sort(), ['A', 'B']);
  console.log('✓ Wer selbst doppelt wollte, wird nicht verdrängt');

  // Soll voll: A (Soll 5) hat 5 Plätze, Doppel steht weiter oben → unwichtigster Wunsch wird frei
  db.settings.totalHorses = 72; // 0,5 pro Pferd → A (10 Pferde) Soll 5, B Soll 1
  db.users[0].horses = 10;
  m = mk();
  const five = ['2026-12-06-out', '2026-12-12-out', '2026-12-13-out', '2026-12-19-out', '2026-12-20-out'];
  m.wishes = { A: [{ s: '2026-12-05-out' }, { s: '2026-12-05-out' }, ...five.map((s) => ({ s }))], B: [{ s: '2026-12-05-out' }, { s: '2026-12-26-in' }] };
  S.phase(m);
  assert.deepStrictEqual(m.assign['2026-12-05-out'].map((p) => p.u), ['A', 'A']);
  assert.ok(!m.assign['2026-12-20-out'].some((p) => p && p.u === 'A'));
  assert.ok(Object.values(m.assign).flat().filter((p) => p && p.u === 'A').length === 5);
  console.log('✓ Soll voll: unwichtigster Wunsch wird für den Doppeldienst freigegeben');

  // Normalisierung: max. 2 je Dienst, altes Format {d:true} wird zu zwei Einträgen
  const nw = S.normWishes([{ s: 'x', d: true }, { s: 'x' }, { s: 'y' }]);
  assert.deepStrictEqual(nw.map((w) => [w.s, w.rep]), [['x', false], ['x', true], ['y', false]]);
  console.log('✓ Wünsche: max. 2 je Dienst');
}
console.log('Alle Tests bestanden.');
