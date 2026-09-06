/* ================= Ausgeschlossene Konten =================
 *
 * Manche Whatnot-Konten sollen die App nicht benutzen duerfen. In der Liste
 * stehen dafuer *keine* Namen im Klartext, sondern nur deren SHA-256-Abdruck:
 * Wer die Datei in die Haende bekommt, erfaehrt daraus nicht, um wen es geht,
 * und kann auch keine Namen daraus ableiten - pruefen laesst sich damit
 * trotzdem, denn der Abdruck eines bekannten Namens ist immer derselbe.
 *
 * Damit das aufgeht, muss vor dem Abdruck immer *gleich* normalisiert werden:
 * Rundherum Leerraum weg, ein fuehrendes @ weg, alles klein. "  @Foo " und
 * "foo" ergeben so denselben Abdruck.
 *
 * Die Liste liegt im Netz, nicht in der App: Sonst wuerde eine Sperre erst
 * greifen, wenn der Betroffene freiwillig ein Update einspielt - was er nicht
 * tun wird. Der Client holt sie stattdessen alle dreissig Minuten frisch von
 * GitHub. Eintragen und Streichen wirkt damit ohne neue Fassung.
 *
 * Was zuletzt geholt wurde, bleibt im Datenordner liegen. Das ist kein
 * Zwischenspeicher aus Bequemlichkeit, sondern der Grund, warum sich eine
 * Sperre nicht durch Netzstecker ziehen aushebeln laesst: Ist die Liste
 * gerade nicht erreichbar, gilt die zuletzt bekannte.
 */
const crypto = require('crypto');
const store = require('./store.js');

const REMOTE_URL = 'https://raw.githubusercontent.com/zqqqqx/whatnot-multistream/main/banned-users.json';
const REFRESH_MS = 30 * 60 * 1000;  // halbstuendlich nachsehen
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 512 * 1024;
const CACHE_KEY = 'wnms.bans.v1';

let cached = null;      // { hashes: [], at, from } - Stand dieser Sitzung
let inFlight = null;    // laeuft gerade eine Abfrage?

function normalize(username) {
  return String(username == null ? '' : username)
    .normalize('NFKC')     // gleich aussehende Schreibweisen zusammenfuehren
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function hash(username) {
  const name = normalize(username);
  if (!name) return '';
  return crypto.createHash('sha256').update(name, 'utf8').digest('hex');
}

// Aus dem Dateiinhalt die brauchbaren Abdruecke ziehen. Akzeptiert sowohl ein
// blankes Feld als auch das Objekt mit "hashes" - beides kommt vor, wenn die
// Datei von Hand bearbeitet wird.
function parseList(text) {
  let raw = String(text || '');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data && data.hashes);
  if (!Array.isArray(list)) throw new Error('kein hashes-Feld');
  return list
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => /^[0-9a-f]{64}$/.test(entry));
}

async function fetchRemote() {
  // Erst hier laden: Zum Zeitpunkt des require() ist Electron noch nicht bereit.
  const { net } = require('electron');
  // Der Anhang haengt nicht am Inhalt, sondern am Zwischenspeicher davor:
  // GitHubs Ausliefernetz haelt die Datei einige Minuten fest und beachtet
  // dabei kein "no-cache". Mit wechselnder Adresse wird jedes Mal wirklich neu
  // geholt - sonst griffe eine frische Sperre erst Minuten spaeter.
  const res = await net.fetch(REMOTE_URL + '?t=' + Date.now(), {
    cache: 'no-cache',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('Liste unerwartet gross');
  return parseList(text);
}

function readCache() {
  const saved = store.get(CACHE_KEY, null);
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.hashes)) return null;
  return { hashes: saved.hashes, at: Number(saved.at) || 0, from: 'cache' };
}

function writeCache(hashes) {
  try { store.set(CACHE_KEY, { hashes: hashes, at: Date.now() }); } catch (err) { /* dann nur diese Sitzung */ }
}

/* Holt die Liste. Klappt das nicht, wird der letzte bekannte Stand benutzt -
 * eine gesetzte Sperre bleibt also bestehen, auch wenn GitHub gerade nicht
 * erreichbar ist. Rueckgabe sagt, woher die Liste stammt. */
async function refresh(force) {
  if (inFlight) return inFlight;
  if (!force && cached && cached.from === 'remote' && Date.now() - cached.at < REFRESH_MS) {
    return cached;
  }

  inFlight = (async () => {
    try {
      const hashes = await fetchRemote();
      cached = { hashes: hashes, at: Date.now(), from: 'remote' };
      writeCache(hashes);
    } catch (err) {
      // Nicht erreichbar: der zuletzt bekannte Stand gilt weiter
      if (!cached || cached.from !== 'remote') cached = readCache() || cached;
    }
    return cached;
  })();

  try { return await inFlight; } finally { inFlight = null; }
}

// Der Stand, ohne selbst ins Netz zu gehen - fuer alles, was sofort antworten muss
function current() {
  if (!cached) cached = readCache();
  return cached;
}

/* Was ist ueber dieses Konto bekannt?
 *
 *   known  - es gibt ueberhaupt eine brauchbare Liste
 *   banned - dieses Konto steht darin
 *
 * Die Unterscheidung ist wichtig: Ohne Liste darf eine bestehende Sperre nicht
 * stillschweigend verfallen, aber auch keine neue entstehen.
 */
async function status(username) {
  let list = current();
  // Beim ersten Mal und wenn der Stand alt ist: nachsehen
  if (!list || list.from !== 'remote' || Date.now() - list.at >= REFRESH_MS) {
    list = await refresh();
  }
  const digest = hash(username);
  if (!list || !digest) return { known: Boolean(list), banned: false, from: list ? list.from : 'none' };
  return { known: true, banned: list.hashes.indexOf(digest) >= 0, from: list.from };
}

async function isBanned(username) {
  return (await status(username)).banned;
}

module.exports = { normalize, hash, status, isBanned, refresh, current, REFRESH_MS, REMOTE_URL, CACHE_KEY };
