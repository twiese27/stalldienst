# Stalldienst 🐴

Faire, digitale Dienstliste für die Wochenend- und Feiertagsdienste (Rein-/Rausbringen) in der Paddock-Saison.
Schluss mit „Zettel hängt seit gestern, alle guten Termine sind weg“.

## Was die App kann

- **Konten für alle Einsteller:innen**, Registrierung nur mit Stall-Code (Einladungslink).
- **Soll pro Person automatisch:** Dienste im Monat ÷ Pferde im Stall × eigene Pferde, aufgerundet.
  Beispiel Dezember 2026: 9 Tage (Wochenenden + 25./26.12.) × 2 Dienste × 2 Plätze = 36 Dienste ÷ 16 Pferde = 2,25 pro Pferd → bei 2 Pferden **5**.
- **Diensttage automatisch:** alle Samstage, Sonntage und Feiertage in Niedersachsen. Weitere Tage (Heiligabend, Silvester …) lassen sich anhaken.
- **Pro Dienst 2 Plätze.** Man kann einen Dienst auch **allein** übernehmen (zählt als 2 Dienste).
- **Push-Benachrichtigungen** aufs Handy (Android, iPhone ab iOS 16.4 als Home-Bildschirm-App, PC).
- **Zwei faire Modi** (pro Monat wählbar):

### Modus 1: Losverfahren (empfohlen)
1. Admin veröffentlicht die Liste → alle bekommen sofort eine Push-Nachricht.
2. Bis zum Stichtag (z. B. 4 Tage) gibt jede:r **Wunschtermine in Reihenfolge** ab. *Wann* man das macht, ist egal.
3. Zum Stichtag lost der Server eine zufällige Reihenfolge aus und verteilt im **Schlangenprinzip**
   (Runde 1: 1→n, Runde 2: n→1, …). Pro Zug gibt's den obersten noch freien Wunsch.
   „Allein“-Wünsche kosten zwei Züge. Niemand bekommt mehr als sein Soll.
4. Alle bekommen eine Nachricht mit ihrem Ergebnis, Restplätze sind dann frei für alle.
5. Reihenfolge und Protokoll der Auslosung sind für alle einsehbar.

### Modus 2: Gleichzeitiger Start
1. Admin veröffentlicht die Liste mit festem Startzeitpunkt → Push an alle.
2. 30 Min. vorher Erinnerung, zum Start nochmal Push. Vorher kann sich niemand eintragen.
3. Ab Start: wer zuerst tippt, bekommt den Platz (der Server entscheidet, doppelt vergeben ist unmöglich).
4. **Runde 1** (z. B. 24 Std.): max. 2 Dienste pro Person – so kann sich niemand alle guten Termine schnappen. Danach bis zum Soll.

### Außerdem
- Selbst austragen bis X Tage vorher (einstellbar), danach nur noch über den Admin.
- Admin kann jeden Platz ändern – auch für Leute ohne Konto/Smartphone („Name ohne Konto“).
- Übersicht, wer wie viele Dienste hat. Druckansicht für den Aushang im Stall.
- Nachricht an alle (z. B. „Pferde bleiben wegen Sturm drin“).

## Starten

Braucht nur **Node.js 18 oder neuer** – keine weiteren Pakete.

```bash
node server.js
```

Dann <http://localhost:3000> öffnen. In der Konsole steht der **Stall-Code**.
**Wer sich als Erstes registriert, wird Admin.**

Umgebungsvariablen:

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` | Port | `3000` |
| `DATA_DIR` | Ordner für die Daten (`db.json`) | `./data` |
| `VAPID_CONTACT` | Kontakt für Push-Dienste, **echte Adresse eintragen** (Apple lehnt Platzhalter ab) | `mailto:stall@example.org` |
| `COOKIE_SECURE` | `1` hinter HTTPS | – |

## Online stellen (wichtig für Push)

Push-Benachrichtigungen funktionieren **nur über HTTPS** und der Server muss **dauerhaft laufen**
(er löst Erinnerungen und die Auslosung zeitgesteuert aus). Kostenlose Hoster, die „einschlafen“, sind daher ungeeignet.

**Einfachster Weg: kleiner Server (z. B. Hetzner/netcup, ca. 4 €/Monat) oder Raspberry Pi mit Docker**

1. Eine (Sub-)Domain auf den Server zeigen lassen (z. B. `stalldienst.deinedomain.de`; kostenlos geht auch mit DuckDNS).
2. In `docker-compose.yml` die Domain und `VAPID_CONTACT` eintragen.
3. `docker compose up -d` – Caddy holt automatisch das HTTPS-Zertifikat.
4. Stall-Code steht in `docker compose logs app`.

Die Daten liegen in `./data/db.json` – diese Datei regelmäßig sichern.
**Nicht löschen:** darin steckt auch der Push-Schlüssel; ohne ihn müssten alle die Benachrichtigungen neu aktivieren.

## Einführung im Stall (Vorschlag)

1. Admin registriert sich zuerst, trägt unter *Admin → Einstellungen* die Gesamtzahl der Pferde und die Uhrzeiten ein.
2. Einladungslink in die WhatsApp-Gruppe / als QR-Code an die Stalltafel.
3. Alle: registrieren, **Benachrichtigungen aktivieren** (iPhone: erst „Zum Home-Bildschirm“).
4. Admin legt den nächsten Monat an, wählt den Modus, setzt den Stichtag/Start und veröffentlicht.

## Test

```bash
node test/test.js
```
Prüft Push-Verschlüsselung, Feiertage/Dienstanzahl und das Losverfahren.
