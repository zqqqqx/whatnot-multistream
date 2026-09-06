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
 * Die Herkunft der Liste steckt allein in readSources(). Heute ist das die
 * mitgelieferte Datei; soll die Liste spaeter aus dem Netz kommen, wird dort
 * eine weitere Quelle eingehaengt - der Rest der App merkt davon nichts, weil
 * er nur isBanned() kennt.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const LIST_FILE = path.join(__dirname, 'banned-users.json');
const CACHE_MS = 5 * 60 * 1000; // Liste hoechstens alle fuenf Minuten neu lesen

let cache = null;
let cacheAt = 0;

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

// Eine Quelle liefert ein Feld mit Abdruecken (Kleinschreibung, hex).
function readLocalFile() {
  try {
    let raw = fs.readFileSync(LIST_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data && data.hashes);
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter((entry) => /^[0-9a-f]{64}$/.test(entry));
  } catch (err) {
    return []; // keine Datei, kaputte Datei: dann sperrt eben nichts
  }
}

// Hier haengen kuenftige Quellen ein (z. B. eine geladene Liste aus dem Netz).
// Jede liefert ein Array von Abdruecken; alle werden zusammengeworfen.
async function readSources() {
  const parts = await Promise.all([
    Promise.resolve(readLocalFile())
  ]);
  const all = new Set();
  for (const part of parts) for (const entry of part) all.add(entry);
  return all;
}

async function list(force) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_MS) return cache;
  cache = await readSources();
  cacheAt = now;
  return cache;
}

async function isBanned(username) {
  const digest = hash(username);
  if (!digest) return false;
  const set = await list();
  return set.has(digest);
}

module.exports = { normalize, hash, isBanned, list, LIST_FILE };
