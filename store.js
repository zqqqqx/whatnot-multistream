/* ================= Dauerhafte Ablage =================
 *
 * Die Streamerliste lag frueher im localStorage des Fensters. Das Fenster
 * benutzt aber dieselbe Ablage-Partition wie die Streams selbst - die
 * Streamerliste stand also mitten in mehreren hundert Megabyte Whatnot-Daten.
 * Wird davon etwas verworfen (Chromium raeumt bei Platzmangel je Herkunft auf,
 * und ein Loeschen der Seitendaten trifft alles darin), ist die Liste weg.
 *
 * Sie liegt deshalb als eigene Datei im Datenordner der App - unabhaengig von
 * allem, was Whatnot dort treibt. Geschrieben wird ueber eine Nebendatei, die
 * anschliessend in einem Zug an ihren Platz gezogen wird: Ein Absturz mitten im
 * Schreiben kann so keine halbe Datei hinterlassen. Die vorige Fassung bleibt
 * als .bak liegen und wird gelesen, falls die Hauptdatei unbrauchbar ist.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const STORE_LIMIT = 4 * 1024 * 1024; // mehr als ein paar Kilobyte wird das nie

function storePath(suffix) {
  return path.join(app.getPath('userData'), 'wnms-store.json' + (suffix || ''));
}

function readFileStore(file) {
  // Ein vorangestelltes Byte-Order-Mark - etwa weil die Datei mit einem Editor
  // angefasst wurde - laesst JSON.parse sonst scheitern und die Ablage
  // faelschlich als beschaedigt gelten.
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // Byte-Order-Mark abstreifen
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('unerwarteter Inhalt');
  return data;
}

function read() {
  try {
    return readFileStore(storePath());
  } catch (err) { /* unten weiter mit der Sicherung */ }

  try {
    const data = readFileStore(storePath('.bak'));
    // Aus der Sicherung gelesen heisst: die Hauptdatei taugt nichts. Sie wird
    // sofort wiederhergestellt - sonst wuerde sie beim naechsten Schreiben als
    // vermeintlich gute Fassung ueber die Sicherung kopiert.
    try { write(data, true); } catch (err) { /* dann eben beim naechsten Mal */ }
    return data;
  } catch (err) { /* auch die Sicherung ist nichts */ }

  return {};
}

function write(data, skipBackup) {
  const text = JSON.stringify(data, null, 2);
  if (text.length > STORE_LIMIT) throw new Error('Ablage unerwartet gross');
  const file = storePath();
  const temp = storePath('.tmp');
  fs.writeFileSync(temp, text, 'utf8');

  // Nur eine *lesbare* Hauptdatei wird zur Sicherung. Eine beschaedigte darf
  // die letzte heile Fassung nicht verdraengen.
  if (!skipBackup) {
    try {
      readFileStore(file);
      fs.copyFileSync(file, storePath('.bak'));
    } catch (err) { /* nicht vorhanden oder unbrauchbar - Sicherung bleibt, wie sie ist */ }
  }

  fs.renameSync(temp, file); // ersetzt die Datei in einem Zug
}

// Zusammenfuehren statt ersetzen: Fenstergroesse schreibt der Hauptprozess,
// alles andere der Renderer. Wuerde jeder die ganze Ablage ueberschreiben,
// loeschte einer dem anderen seine Eintraege.
function merge(data) {
  write(Object.assign(read(), data));
}

// Ein einzelner Eintrag - fuer alles, was der Hauptprozess selbst verwaltet
function get(key, fallback) {
  const data = read();
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
}

function set(key, value) {
  merge({ [key]: value });
}

module.exports = { read, write, merge, get, set, storePath };
