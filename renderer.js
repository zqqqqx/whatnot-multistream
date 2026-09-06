'use strict';

const MAX_USERS = 40;   // so viele Streamer duerfen beobachtet werden
const MAX_TILES = 20;   // so viele Kacheln laufen gleichzeitig
const PARTITION = 'persist:whatnot';
// Preload je Kachel - setzt den Zoom frameweise statt fuer die ganze Herkunft
const PRELOAD_URL = new URL('preload-tile.js', location.href).href;

const USERS_KEY = 'wnms.users.v1';
const STREAMS_KEY = 'wnms.streams.v1'; // alte Fassung, wird einmalig uebernommen
const SETTINGS_KEY = 'wnms.settings.v1';
const SHIPPING_KEY = 'wnms.shipping.v1'; // Verkaeufer, bei denen der Versand heute schon laeuft

// Wie oft im Hintergrund geprueft wird, wer gerade live ist
const CHECK_INTERVAL = 120000; // 2 Minuten
const PROBE_GAP = 600;         // Pause zwischen zwei Profilen
// Ruheplatz des Pruef-Fensters: gleiche Herkunft wie die Profilseiten (Anmeldung
// und Cookies gelten also), aber nur ein paar Zeilen Text statt der ganzen App.
const CHECKER_HOME = 'https://www.whatnot.com/robots.txt';

// Diese Zustaende meldet Whatnot fuer eine wirklich laufende Show.
// "CREATED" ist eine nur geplante Show und wird bewusst ignoriert.
const LIVE_STATUS = /^(PLAYING|LIVE|ACTIVE|STARTED|STREAMING)$/i;

// Kacheln im Smartphone-Format - so sendet Whatnot (hochkant) und so zeigt die
// Seite im schmalen Fenster ihr Handy-Layout mit Video und Chat.
const PORTRAIT_ASPECT = 9 / 16;
const TILE_GAP = 6;

// Jede Vorschaukachel zeigt die Seite mit immer derselben logischen Breite; die
// Kachelgroesse bestimmt nur den Massstab. Damit bleibt das Verhaeltnis von Chat
// zu Videobild gleich, egal wie viele Streams laufen oder wie gross das Fenster
// ist - bei wenigen, grossen Kacheln wird der Chat schlicht groesser, statt dass
// Whatnot auf ein breiteres Layout mit schmalem Chat umschaltet.
const TILE_BASE_WIDTH = 400;
const MIN_PREVIEW_ZOOM = 0.25;
const MAX_PREVIEW_ZOOM = 3;

// Die fokussierte Kachel laeuft in Originalgroesse - nur dort sind die
// Gebots-Schaltflaechen bedienbar. Fuer Kleingedrucktes gibt es dort die Lupe.
const FOCUS_ZOOM = 1;

let previewZoom = 0.5;

// Lupe: Groesse des Glases in Pixeln, Vergroesserung des Ausschnitts.
// Gesteuert wird sie ueber genau eine gehaltene Taste; das Mausrad hat damit
// nichts mehr zu tun (Groesse und Vergroesserung stehen in den Einstellungen).
const LENS_KEY = 'Alt';        // muss zu LENS_KEY in preload-tile.js passen
const LENS_KEY_LABEL = 'Alt';
const LENS_START_SIZE = 260;
const LENS_MIN_SIZE = 140;
const LENS_MAX_SIZE = 620;
const LENS_START_MAG = 2.5;
const LENS_MIN_MAG = 1.5;
const LENS_MAX_MAG = 8;
const LENS_FRAME_MS = 90;
const LENS_GUARD_MS = 400;     // Takt des Waechters gegen eine haengende Lupe

// Uebergang zwischen Vorschau und grossem Modus (siehe setFocus)
const MORPH_MOVE_MS = 240;    // Standbild in die neue Groesse fahren
const MORPH_SETTLE_MS = 2600; // laengstens auf die Fertigmeldung der Seite warten
const MORPH_BUSY_MS = 400;    // ab hier zeigt das Standbild einen kleinen Puffer
const MORPH_FADE_MS = 140;    // Standbild wegblenden
const MORPH_EASE = 'cubic-bezier(.22, .61, .36, 1)';
// Notbremse: der Deckel liegt ueber der ganzen Buehne, er darf unter keinen
// Umstaenden haengen bleiben - etwa wenn das Fenster mitten im Wechsel
// minimiert wird und Chromium Bilder und Animationen anhaelt.
const MORPH_MAX_MS = 5200;

// Scrollbalken in den Kacheln ausblenden - gescrollt werden kann trotzdem.
const HIDE_SCROLLBARS_CSS = `
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  html { scrollbar-width: none !important; -ms-overflow-style: none !important; }
`;

// "Nur Video": alles unsichtbar schalten und allein das Video wieder einblenden.
// Sichtbarkeit vererbt sich, laesst sich aber am Nachfahren zurueckholen - so
// braucht die Regel keine Kenntnis von Whatnots Klassennamen.
const CLEAN_VIDEO_CSS = `
  body > *:not(script):not(style) { visibility: hidden !important; }
  video {
    visibility: visible !important;
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    max-width: none !important;
    max-height: none !important;
    object-fit: contain !important;
    background: #000 !important;
    z-index: 2147483647 !important;
  }
`;

// Schliesst den Cookie-Banner mit der datensparsamen Option ("Nur notwendige").
const DISMISS_COOKIES_JS = `(() => {
  const wanted = /^(nur notwendige|nur erforderliche|only necessary|essential only|alle ablehnen|reject all|decline all)/i;
  const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const hit = candidates.find(el => wanted.test((el.textContent || '').trim()));
  if (hit) { hit.click(); return true; }
  return false;
})()`;

/* ================= Profil auswerten =================
 *
 * Diese Funktion wird als Text in die Whatnot-Seite gereicht (siehe fetchProbeJs /
 * domProbeJs) und laeuft dort - sie darf deshalb nichts aus dieser Datei benutzen.
 *
 * Eine Profilseite listet unter "Anstehende Shows" sowohl die gerade laufende als
 * auch geplante Shows auf. Unterschieden werden sie ueber den Status aus den
 * eingebetteten Seitendaten ("PLAYING" gegen "CREATED"); faellt der Weg aus, dient
 * der rote "Live"-Aufkleber der Kachel als Ersatzkennzeichen.
 */
function readProfile(input, user) {
  const want = String(user || '').toLowerCase();
  const html = typeof input === 'string' ? input : '';
  let doc = typeof input === 'string' ? null : input;
  const shows = [];
  const seen = {};

  function unescapeJson(raw) {
    if (!raw) return '';
    try { return JSON.parse('"' + raw + '"'); } catch (err) { return raw; }
  }

  // 1) Die Seite bringt ihre Daten im Klartext mit - das ist die genaue Auskunft.
  const parts = html.split('"__typename":"LiveStream"');
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i].slice(0, 6000);
    const idHit = chunk.match(/"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    if (!idHit || seen[idHit[1]]) continue;
    const owner = (chunk.match(/"username":"([^"]*)"/) || [])[1] || '';
    if (want && owner && owner.toLowerCase() !== want) continue;
    seen[idHit[1]] = 1;
    shows.push({
      id: idHit[1],
      status: (chunk.match(/"status":"([A-Z_]+)"/) || [])[1] || '',
      title: unescapeJson((chunk.match(/"title":"((?:[^"\\]|\\.)*)"/) || [])[1]),
      thumb: unescapeJson((chunk.match(/"(?:smallImage|biggerImage)":"((?:[^"\\]|\\.)*)"/) || [])[1]),
      viewers: Number((chunk.match(/"activeViewers":(\d+)/) || [])[1] || 0),
      start: Number((chunk.match(/"startTime":(\d+)/) || [])[1] || 0),
      source: 'data'
    });
  }

  // 2) Ersatzweg: die fertig gerenderten Show-Kacheln ansehen.
  if (!shows.length) {
    if (!doc && html) {
      try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (err) { doc = null; }
    }
    const cards = doc ? doc.querySelectorAll('[data-testid="livestream-card"], [data-type="LivestreamCard"]') : [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const ownerLink = card.querySelector('a[href*="/user/"]');
      if (want && ownerLink) {
        const hit = (ownerLink.getAttribute('href') || '').match(/\/user\/([^/?#]+)/);
        let name = hit ? hit[1] : '';
        try { name = decodeURIComponent(name); } catch (err) { /* roh vergleichen */ }
        if (name && name.toLowerCase() !== want) continue;
      }
      const link = card.querySelector('a[href*="/live/"]');
      if (!link) continue;
      const idHit = (link.getAttribute('href') || '').match(/\/live\/([0-9a-f-]{36})/i);
      if (!idHit || seen[idHit[1]]) continue;
      seen[idHit[1]] = 1;
      // Der rote "Live - 54"-Aufkleber trennt die laufende von der geplanten Show.
      const badge = card.querySelector('[class*="live-red"], [class*="brand-live"]');
      const badgeText = badge ? (badge.textContent || '').trim() : '';
      const titleEl = card.querySelector('a[href*="/live/"] strong, a[href*="/live/"] [title]');
      const imgEl = card.querySelector('img');
      shows.push({
        id: idHit[1],
        status: /^live\b/i.test(badgeText) ? 'PLAYING' : 'CREATED',
        title: titleEl ? ((titleEl.getAttribute('title') || titleEl.textContent || '').trim()) : '',
        thumb: imgEl ? (imgEl.getAttribute('src') || '') : '',
        viewers: Number((badgeText.match(/(\d+)\s*$/) || [])[1] || 0),
        start: 0,
        source: 'dom'
      });
    }
  }

  // 3) Profilbild. Im Datenblock haengt es am Benutzer, im gerenderten HTML
  //    steht es als <img alt="name">. Beides wird versucht; findet sich nichts,
  //    zeigt die Liste stattdessen den Anfangsbuchstaben.
  let avatar = '';
  if (want && html) {
    const lower = html.toLowerCase();
    const tag = 'alt="' + want + '"';
    let at = lower.indexOf(tag);
    while (at >= 0 && !avatar) {
      const around = html.slice(Math.max(0, at - 800), at + 800);
      const hit = around.match(/https:\/\/images\.whatnot\.com\/fit-in\/[^"'\s)]+/);
      if (hit) avatar = hit[0];
      at = lower.indexOf(tag, at + 1);
    }
    if (!avatar) {
      const pos = lower.indexOf('"username":"' + want + '"');
      if (pos >= 0) {
        const around = html.slice(Math.max(0, pos - 1500), pos + 1500);
        const hit = around.match(/"profileImage":\{[^}]*"url":"([^"]+)"/);
        if (hit) avatar = hit[1];
      }
    }
  }
  if (!avatar && doc && want) {
    const img = doc.querySelector('img[alt="' + want + '"]');
    if (img) avatar = img.getAttribute('src') || '';
  }

  // 4) Nebenbei: Whatnot legt den angemeldeten Nutzer in jede Seite
  //    (window.__whatnot__.loggerContext.usr.name). Das kostet hier nichts
  //    extra und haelt den erkannten eigenen Namen aktuell - auch dann, wenn
  //    sich jemand zwischendurch im Browserfenster anders anmeldet.
  let me = '';
  try {
    const source = html || (doc && doc.documentElement ? doc.documentElement.innerHTML : '');
    const hit = source.match(/"loggerContext":[^]{0,400}?"name":"([^"]+)"/);
    if (hit && /^[A-Za-z0-9_.-]{2,40}$/.test(hit[1])) me = hit[1];
  } catch (err) { /* dann eben nicht */ }

  return { ok: true, shows: shows, avatar: avatar, me: me };
}

const READ_PROFILE_SRC = readProfile.toString();

// Holt die Profilseite als Text - laeuft im Whatnot-Tab, damit Herkunft und
// Anmeldung stimmen, und wertet sie gleich dort aus (die Seite ist ~2 MB gross).
function fetchProbeJs(username) {
  return `(async () => {
  const read = ${READ_PROFILE_SRC};
  const user = ${JSON.stringify(username)};
  try {
    const res = await fetch('/de-DE/user/' + encodeURIComponent(user), { credentials: 'include' });
    if (res.status === 404) return { ok: true, shows: [], missing: true };
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const html = await res.text();
    const marker = '__typename' + '":"LiveStream';
    const looksRight = html.indexOf('livestream-card') >= 0
      || html.indexOf(marker) >= 0
      || html.indexOf('/user/' + user) >= 0;
    if (!looksRight) return { ok: false, error: 'Profilseite nicht lesbar' };
    return read(html, user);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

function domProbeJs(username) {
  return `(() => { const read = ${READ_PROFILE_SRC}; return read(document, ${JSON.stringify(username)}); })()`;
}

/* ================= Elemente und Speicher ================= */

const els = {
  stage: document.getElementById('stage'),
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  emptyIntro: document.getElementById('emptyIntro'),
  emptyLoading: document.getElementById('emptyLoading'),
  emptyIdle: document.getElementById('emptyIdle'),
  loadingWho: document.getElementById('loadingWho'),
  idleInfo: document.getElementById('idleInfo'),
  count: document.getElementById('count'),
  cols: document.getElementById('colsSelect'),
  check: document.getElementById('checkBtn'),
  viewAll: document.getElementById('viewAllBtn'),
  muteAll: document.getElementById('muteAllBtn'),
  reloadAll: document.getElementById('reloadAllBtn'),
  login: document.getElementById('loginBtn'),
  dragOverlay: document.getElementById('dragOverlay'),
  menu: document.getElementById('tileMenu'),
  menuTitle: document.getElementById('tileMenuTitle'),
  shows: document.getElementById('showsBtn'),
  panel: document.getElementById('showsPanel'),
  panelClose: document.getElementById('showsClose'),
  userForm: document.getElementById('userForm'),
  userInput: document.getElementById('userInput'),
  userHidden: document.getElementById('userHidden'),
  meInput: document.getElementById('meInput'),
  meSave: document.getElementById('meSave'),
  meState: document.getElementById('meState'),
  panelCount: document.getElementById('panelCount'),
  copyBtn: document.getElementById('copyBtn'),
  userList: document.getElementById('userList'),
  checkInfo: document.getElementById('checkInfo'),
  checkNow: document.getElementById('checkNowBtn'),
  updateBtn: document.getElementById('updateBtn'),
  updateLabel: document.getElementById('updateLabel'),
  hiddenBtn: document.getElementById('hiddenBtn'),
  hiddenCount: document.getElementById('hiddenCount'),
  hiddenPop: document.getElementById('hiddenPop'),
  hiddenList: document.getElementById('hiddenList'),
  morph: document.getElementById('morph'),
  morphShot: document.getElementById('morphShot'),
  morphBusy: document.getElementById('morphBusy'),
  lens: document.getElementById('lens'),
  lensImage: document.getElementById('lensImage'),
  lensLabel: document.getElementById('lensLabel'),
  lensPop: document.getElementById('lensPop'),
  lensPopKey: document.getElementById('lensPopKey'),
  lensPopSize: document.getElementById('lensPopSize'),
  lensPopSizeOut: document.getElementById('lensPopSizeOut'),
  lensPopMag: document.getElementById('lensPopMag'),
  lensPopMagOut: document.getElementById('lensPopMagOut'),
  toast: document.getElementById('toast'),
  checker: document.getElementById('checker'),

  // eigene Titelleiste
  winMin: document.getElementById('winMin'),
  winMax: document.getElementById('winMax'),
  winClose: document.getElementById('winClose'),

  // Einstellungen
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  settingsClose: document.getElementById('settingsClose'),
  settingsTabs: document.getElementById('settingsTabs'),
  optStartCheck: document.getElementById('optStartCheck'),
  optRestoreSound: document.getElementById('optRestoreSound'),
  optCols: document.getElementById('optCols'),
  optView: document.getElementById('optView'),
  optShowLot: document.getElementById('optShowLot'),
  optShowTotal: document.getElementById('optShowTotal'),
  optLensSize: document.getElementById('optLensSize'),
  optLensSizeOut: document.getElementById('optLensSizeOut'),
  optLensMag: document.getElementById('optLensMag'),
  optLensMagOut: document.getElementById('optLensMagOut'),
  optSetupAgain: document.getElementById('optSetupAgain'),
  lensKeyHint: document.getElementById('lensKeyHint'),

  // Konto
  accAvatar: document.getElementById('accAvatar'),
  accName: document.getElementById('accName'),
  accState: document.getElementById('accState'),
  accDot: document.getElementById('accDot'),
  accLogin: document.getElementById('accLogin'),
  accLoginLabel: document.getElementById('accLoginLabel'),

  // Updates und Ueber
  aboutVersion: document.getElementById('aboutVersion'),
  aboutHint: document.getElementById('aboutHint'),
  updateResult: document.getElementById('updateResult'),
  updateCheckBtn: document.getElementById('updateCheckBtn'),
  updateActionRow: document.getElementById('updateActionRow'),
  updateActionText: document.getElementById('updateActionText'),
  updateActionBtn: document.getElementById('updateActionBtn'),
  repoBtn: document.getElementById('repoBtn'),

  // Einrichtung
  setup: document.getElementById('setup'),
  setupSteps: document.getElementById('setupSteps'),
  setupLogin: document.getElementById('setupLogin'),
  setupLoginState: document.getElementById('setupLoginState'),
  setupWho: document.getElementById('setupWho'),
  setupForm: document.getElementById('setupForm'),
  setupInput: document.getElementById('setupInput'),
  setupList: document.getElementById('setupList'),
  setupSkip: document.getElementById('setupSkip'),
  setupBack: document.getElementById('setupBack'),
  setupNext: document.getElementById('setupNext'),

  // Sperre
  locked: document.getElementById('lockedOverlay'),
  lockedWho: document.getElementById('lockedWho'),
  lockedQuit: document.getElementById('lockedQuit')
};

function icon(name) {
  const el = document.createElement('i');
  el.className = 'fa-solid ' + name;
  return el;
}

/* ---------- Dauerhafte Ablage ----------
 *
 * Massgeblich ist eine Datei im Datenordner der App (siehe main.js). Der
 * localStorage wird nur noch als Zweitschrift mitgefuehrt und beim ersten Start
 * einmal ausgelesen - er liegt in derselben Partition wie die Whatnot-Seiten
 * und ist damit nicht verlaesslich genug fuer die Streamerliste.
 */
const persistence = (window.wnms && window.wnms.store) ? window.wnms.store : null;
const storeData = persistence ? (persistence.readSync() || {}) : null;

function load(key, fallback) {
  // 1. die Datei
  if (storeData && Object.prototype.hasOwnProperty.call(storeData, key)) {
    return storeData[key];
  }
  // 2. einmalige Uebernahme aus der alten Ablage
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const value = JSON.parse(raw);
      if (storeData) { storeData[key] = value; storeDirty.add(key); flushStore(); }
      return value;
    }
  } catch (err) { /* unbrauchbar - dann eben der Ersatzwert */ }
  return fallback;
}

let storeFailed = false;

/* Geschrieben wird nur, was dieses Fenster selbst geaendert hat.
 *
 * Der Grund: storeData ist die Abschrift vom Programmstart. Wuerde jedes Mal
 * die ganze Abschrift hinausgehen, schriebe das Fenster auch Eintraege zurueck,
 * die inzwischen der Hauptprozess gesetzt hat - Fenstergroesse, erkanntes Konto,
 * Sperre. Die waeren damit auf dem Stand von vorhin und effektiv verworfen.
 * (Genau daran ist eine gesetzte Sperre zuerst wieder verschwunden.)
 */
const storeDirty = new Set();

function flushStore() {
  if (!persistence || !storeData || !storeDirty.size) return;
  const patch = {};
  for (const key of storeDirty) patch[key] = storeData[key];
  storeDirty.clear();
  persistence.write(patch).then((ok) => {
    if (ok || storeFailed) return;
    // Einmal melden, nicht bei jedem Schreibversuch
    storeFailed = true;
    toast('Achtung: Einstellungen lassen sich gerade nicht sichern');
  }).catch(() => {});
}

function store(key, value) {
  if (storeData) {
    storeData[key] = value;
    storeDirty.add(key);
    flushStore();
  }
  // Zweitschrift, damit eine aeltere Fassung der App die Liste noch findet
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) { /* die Datei ist das Original */ }
}

function makeUser(username, hidden) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username: username,
    hidden: Boolean(hidden)
  };
}

// Aus der alten Stream-Liste die Profil-Kacheln als User uebernehmen.
// Direkte Live-Links lassen sich keinem Namen zuordnen und entfallen.
function migrateStreams() {
  const old = load(STREAMS_KEY, null);
  if (!Array.isArray(old)) return [];
  const out = [];
  const seen = {};
  for (const entry of old) {
    const hit = String((entry && entry.url) || '').match(/whatnot\.com\/(?:[a-z]{2}-[a-z]{2}\/)?user\/([^/?#]+)/i);
    if (!hit) continue;
    let name = hit[1];
    try { name = decodeURIComponent(name); } catch (err) { /* roh uebernehmen */ }
    if (seen[name.toLowerCase()]) continue;
    seen[name.toLowerCase()] = 1;
    out.push(makeUser(name, false));
  }
  return out;
}

let users = load(USERS_KEY, null);
if (!Array.isArray(users)) {
  // Hier lag der eigentliche Verlust: Kam beim Lesen nichts zurueck - aus
  // welchem Grund auch immer -, wurde sofort eine leere Liste darueber
  // geschrieben und war damit endgueltig weg. Geschrieben wird jetzt nur noch,
  // wenn dabei auch wirklich etwas herauskommt.
  users = migrateStreams();
  if (users.length) store(USERS_KEY, users);
}

let settings = Object.assign({
  cols: 'auto',
  me: '',
  view: 'full',        // Voreinstellung fuer neue Kacheln, vom Knopf oben gesetzt
  unmuted: null,       // welcher Streamer zuletzt Ton hatte
  lensSize: 0,         // Groesse des Lupenglases
  lensMag: 0,          // Vergroesserung der Lupe
  showLot: true,       // Los-Leiste am unteren Kachelrand
  showTotal: true,     // Gesamtpreis inklusive Versand darunter
  startCheck: true,    // beim Start sofort nachsehen, wer live ist
  restoreSound: true   // den zuletzt hoerbaren Stream wieder aufdrehen
}, load(SETTINGS_KEY, {}));

function saveSettings() {
  store(SETTINGS_KEY, settings);
}

/* ================= Versand-Buendelung =================
 *
 * Whatnot fasst den Versand pro Verkaeufer und Tag zusammen: Wer bei demselben
 * Verkaeufer heute schon etwas ersteigert hat, zahlt fuer das naechste Los keinen
 * zweiten Versand. Das ist ein Preisvorteil, den man beim Vergleich zweier
 * Kacheln sonst uebersieht - deshalb merkt sich die App, wo heute schon ein
 * Zuschlag gefallen ist, und zeigt es an der Kachel an.
 *
 * Erkannt wird das an "<name> hat gewonnen!" in der Show, sofern der Name dem
 * eigenen entspricht (Einstellung "me"). Wer den nicht eintraegt, kann den
 * Merker im Kachelmenue von Hand setzen.
 */
let shipping = load(SHIPPING_KEY, {}); // userId -> { date, count, fee }

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Nur der heutige Eintrag zaehlt - gestern gezahlter Versand hilft nicht mehr.
function shippingOf(userId) {
  const entry = shipping[userId];
  if (!entry || entry.date !== today()) return null;
  return entry;
}

function markShipping(userId, fee, byHand) {
  const entry = shippingOf(userId);
  shipping[userId] = {
    date: today(),
    count: (entry ? entry.count : 0) + 1,
    fee: fee || (entry && entry.fee) || '',
    byHand: Boolean(byHand)
  };
  store(SHIPPING_KEY, shipping);
  const tile = tiles.get(userId);
  if (tile) renderLot(tile);
  renderUserList();
}

function clearShipping(userId) {
  delete shipping[userId];
  store(SHIPPING_KEY, shipping);
  const tile = tiles.get(userId);
  if (tile) renderLot(tile);
  renderUserList();
}

const states = new Map(); // userId -> Live-Zustand
const tiles = new Map();  // userId -> Kachel
let focusedId = null;
// Der zuletzt hoerbare Stream wird wieder aufgedreht, sobald seine Kachel da
// ist - sofern das in den Einstellungen so bleibt.
let unmutedId = settings.restoreSound === false ? null : (settings.unmuted || null);
let unmutedBeforeFocus = null; // Ton, der vor dem Vergroessern lief
let lens = null;

function stateOf(user) {
  let state = states.get(user.id);
  if (!state) {
    state = {
      live: false, showId: null, liveUrl: null, title: '', thumb: '', viewers: 0,
      nextStart: 0, missing: false, error: null, lastCheck: 0
    };
    states.set(user.id, state);
  }
  return state;
}

function profileUrl(username) {
  return 'https://www.whatnot.com/de-DE/user/' + encodeURIComponent(username);
}

function liveUrl(showId) {
  return 'https://www.whatnot.com/live/' + showId;
}

// Links koennen ein Sprachkuerzel enthalten: whatnot.com/de-DE/live/<id>
function isLiveUrl(url) {
  return /whatnot\.com\/(?:[a-z]{2}-[a-z]{2}\/)?live\//i.test(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openInBrowser(url) {
  if (!url) return;
  if (window.wnms && window.wnms.openExternal) window.wnms.openExternal(url);
  else window.open(url, '_blank');
}

/* ================= Hintergrundpruefung ================= */

let checkerReady = false;
els.checker.addEventListener('dom-ready', () => {
  checkerReady = true;
  try { els.checker.setAudioMuted(true); } catch (err) {}
});

async function whenCheckerReady() {
  for (let i = 0; i < 120 && !checkerReady; i++) await sleep(500);
  return checkerReady;
}

// Der Helfer kann immer nur eine Sache tun - Anfragen laufen deshalb der Reihe nach.
let queueTail = Promise.resolve();
function queued(fn) {
  const run = queueTail.then(() => fn(), () => fn());
  queueTail = run.then(() => {}, () => {});
  return run;
}

function backToHome() {
  setTimeout(() => {
    try { els.checker.loadURL(CHECKER_HOME); } catch (err) {}
  }, 200);
}

// Reserveweg: Profil wirklich laden und die gerenderte Seite ansehen.
async function domProbe(username) {
  try {
    els.checker.loadURL(profileUrl(username));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  const target = ('/user/' + encodeURIComponent(username)).toLowerCase();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(500);
    let loading = true;
    let here = '';
    try {
      loading = els.checker.isLoading();
      here = (els.checker.getURL() || '').toLowerCase();
    } catch (err) { /* Fenster noch nicht bereit */ }
    if (loading || here.indexOf(target) < 0) continue;

    await sleep(2500); // die Show-Kacheln rendert Whatnot erst im Browser nach
    let out;
    try {
      out = await els.checker.executeJavaScript(domProbeJs(username), true);
    } catch (err) {
      out = { ok: false, error: String((err && err.message) || err) };
    }
    backToHome();
    return out;
  }
  backToHome();
  return { ok: false, error: 'Zeitueberschreitung beim Laden des Profils' };
}

async function probe(username) {
  if (!(await whenCheckerReady())) return { ok: false, error: 'Pruef-Fenster nicht bereit' };

  let viaFetch;
  try {
    viaFetch = await els.checker.executeJavaScript(fetchProbeJs(username), true);
  } catch (err) {
    viaFetch = { ok: false, error: String((err && err.message) || err) };
  }
  if (viaFetch && viaFetch.ok) return viaFetch;

  const viaDom = await domProbe(username);
  if (viaDom && viaDom.ok) return viaDom;
  return viaFetch || viaDom || { ok: false, error: 'Pruefung fehlgeschlagen' };
}

function applyProbe(user, result) {
  const state = stateOf(user);
  const wasLive = state.live;
  const oldUrl = state.liveUrl;

  state.lastCheck = Date.now();

  if (!result || !result.ok) {
    state.error = (result && result.error) || 'Pruefung fehlgeschlagen';
    renderUserList();
    return;
  }

  state.error = null;
  state.missing = Boolean(result.missing);

  // Der eigene Name faellt beim Pruefen nebenbei ab - dort laeuft er durch
  // dieselbe Stelle wie nach dem Anmelden (Konto merken, Sperre pruefen).
  if (result.me) reportAccount(result.me);

  // Profilbild einmal merken - es steht dann sofort beim naechsten Start da
  if (result.avatar && user.avatar !== result.avatar) {
    user.avatar = result.avatar;
    store(USERS_KEY, users);
  }

  const shows = result.shows || [];
  const running = shows.filter((show) => LIVE_STATUS.test(show.status || ''));
  const upcoming = shows
    .filter((show) => !LIVE_STATUS.test(show.status || '') && show.start > 0)
    .sort((a, b) => a.start - b.start);

  state.nextStart = upcoming.length ? upcoming[0].start : 0;

  if (running.length) {
    const show = running[0];
    state.live = true;
    state.showId = show.id;
    state.liveUrl = liveUrl(show.id);
    state.title = show.title || '';
    state.thumb = show.thumb || '';
    state.viewers = show.viewers || 0;
  } else {
    state.live = false;
    state.showId = null;
    state.liveUrl = null;
    state.title = '';
    state.thumb = '';
    state.viewers = 0;
  }

  if (state.live && !wasLive) {
    toast(user.username + ' ist live' + (user.hidden ? ' (versteckt)' : ''));
  } else if (!state.live && wasLive) {
    toast(user.username + ' hat die Show beendet');
  } else if (state.live && wasLive && oldUrl && oldUrl !== state.liveUrl) {
    toast(user.username + ': neue Show');
  }

  syncTiles();
  renderUserList();
}

let checking = 0;
let lastRound = 0;
let checkingUser = null; // Name des Profils, das gerade an der Reihe ist

function checkUser(user) {
  // Sofort mitzaehlen (nicht erst beim Start der Aufgabe), sonst wuerde ein
  // zweiter Klick auf "Prüfen" eine komplette Runde doppelt einreihen.
  checking++;
  updateCheckInfo();
  return queued(async () => {
    try {
      if (users.indexOf(user) < 0) return;
      checkingUser = user.username;
      updateEmptyState();
      applyProbe(user, await probe(user.username));
      await sleep(PROBE_GAP);
    } finally {
      checking--;
      if (!checking) checkingUser = null;
      updateCheckInfo();
    }
  });
}

function checkAll() {
  if (locked) return false;
  if (checking > 0) return false;
  if (!users.length) return false;
  for (const user of users.slice()) checkUser(user);
  queued(async () => {
    lastRound = Date.now();
    updateCheckInfo();
  });
  return true;
}

function updateCheckInfo() {
  if (checking > 0) {
    els.checkInfo.textContent = 'Prüfe gerade …';
  } else if (lastRound) {
    const time = new Date(lastRound).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    els.checkInfo.textContent = 'Zuletzt geprüft ' + time + ' · alle 2 Minuten';
  } else {
    els.checkInfo.textContent = 'Prüfung alle 2 Minuten';
  }
  els.check.classList.toggle('busy', checking > 0);
  updateEmptyState();
}

/* ================= Leerzustand =================
 *
 * Ohne laufende Kachel zeigt die Buehne je nach Lage drei verschiedene Karten:
 * die Einfuehrung, das Radar waehrend der Pruefung oder die Ruhemeldung.
 */
function updateEmptyState() {
  const idle = tiles.size === 0;
  els.empty.hidden = !idle;
  if (!idle) return;

  const noUsers = users.length === 0;
  // Vor der ersten abgeschlossenen Runde laeuft die Pruefung noch an - dann
  // soll das Radar sofort zu sehen sein, nicht erst "niemand live".
  const busy = !noUsers && (checking > 0 || !lastRound);

  els.emptyIntro.hidden = !noUsers;
  els.emptyLoading.hidden = noUsers || !busy;
  els.emptyIdle.hidden = noUsers || busy;

  if (busy) {
    const rest = checking > 1 ? ' · noch ' + (checking - 1) + ' Profile' : '';
    els.loadingWho.textContent = checkingUser
      ? 'prüfe ' + checkingUser + rest
      : 'Prüfung wird vorbereitet …';
    return;
  }

  if (noUsers) return;

  const hiddenLive = hiddenLiveUsers().length;
  if (hiddenLive) {
    els.idleInfo.textContent = hiddenLive === 1
      ? 'Eine versteckte Show läuft gerade – oben über das Augen-Symbol einblenden.'
      : hiddenLive + ' versteckte Shows laufen gerade – oben über das Augen-Symbol einblenden.';
    return;
  }
  const time = lastRound
    ? new Date(lastRound).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : null;
  els.idleInfo.textContent = 'Keiner der ' + users.length + ' beobachteten Streamer sendet'
    + (time ? ' (zuletzt geprüft ' + time + ').' : '.');
}

let checkTimer = setInterval(checkAll, CHECK_INTERVAL);

/* ================= Kacheln ================= */

function addTileButton(parent, iconName, title) {
  const button = document.createElement('button');
  button.title = title;
  button.appendChild(icon(iconName));
  parent.appendChild(button);
  return button;
}

function createTile(user, state) {
  const el = document.createElement('section');
  el.className = 'tile';

  const head = document.createElement('div');
  head.className = 'tile-head';

  const liveDot = document.createElement('span');
  liveDot.className = 'live-dot';
  liveDot.title = 'Live';

  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = user.username;
  name.title = profileUrl(user.username);

  const title = document.createElement('span');
  title.className = 'tile-title';

  const actions = document.createElement('div');
  actions.className = 'tile-actions';

  const audioBtn = addTileButton(actions, 'fa-volume-xmark', 'Ton für diesen Stream einschalten');
  const viewBtn = addTileButton(actions, 'fa-comments', 'Chat ausblenden');
  // Nur in der Großansicht: erklärt die Lupe und stellt sie ein
  const lensBtn = addTileButton(actions, 'fa-magnifying-glass', 'Lupe: ' + LENS_KEY_LABEL + ' halten');
  const externalBtn = addTileButton(actions, 'fa-arrow-up-right-from-square', 'Show im Browser öffnen');
  const focusBtn = addTileButton(actions, 'fa-expand', 'Groß anzeigen');
  const shrinkBtn = addTileButton(actions, 'fa-compress', 'Fokus verlassen');
  const reloadBtn = addTileButton(actions, 'fa-rotate-right', 'Neu laden');
  shrinkBtn.hidden = true;
  lensBtn.hidden = true;

  head.append(liveDot, name, title, actions);

  const body = document.createElement('div');
  body.className = 'tile-body';

  const webview = document.createElement('webview');
  webview.setAttribute('src', state.liveUrl);
  webview.setAttribute('partition', PARTITION);
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('preload', PRELOAD_URL);

  const status = document.createElement('div');
  status.className = 'tile-status';
  status.textContent = 'Lädt …';

  // Los-Leiste: was gerade unter dem Hammer ist, ohne die Kachel gross zu machen
  const lotBar = document.createElement('div');
  lotBar.className = 'tile-lot';
  lotBar.hidden = true;
  const lotShip = document.createElement('span');
  lotShip.className = 'lot-ship';
  lotShip.hidden = true;
  lotShip.appendChild(icon('fa-truck-fast'));
  const lotShipCount = document.createElement('b');
  lotShip.appendChild(lotShipCount);
  const lotTitle = document.createElement('span');
  lotTitle.className = 'lot-title';
  // Preisblock: oben das naechste Gebot, darunter kleiner die Summe mit Versand
  const lotPrice = document.createElement('span');
  lotPrice.className = 'lot-price';
  const lotBid = document.createElement('b');
  lotBid.className = 'lot-bid';
  const lotTotal = document.createElement('small');
  lotTotal.className = 'lot-total';
  lotTotal.hidden = true;
  lotPrice.append(lotBid, lotTotal);
  const lotTime = document.createElement('span');
  lotTime.className = 'lot-time';
  lotBar.append(lotShip, lotTitle, lotPrice, lotTime);

  body.append(webview, status, lotBar);
  el.append(head, body);

  const tile = {
    el,
    webview,
    statusEl: status,
    titleEl: title,
    nameEl: name,
    audioBtn,
    viewBtn,
    lensBtn,
    focusBtn,
    shrinkBtn,
    id: user.id,
    liveUrl: state.liveUrl,
    // view = was gerade gilt, gridView = was im Raster eingestellt ist.
    // Die Grossansicht setzt nur "view" und laesst "gridView" unberuehrt.
    view: VIEW_LOOK[user.view] ? user.view : (settings.view || 'full'),
    gridView: VIEW_LOOK[user.view] ? user.view : (settings.view || 'full'),
    cleanKey: null,
    lotBar,
    lotShip,
    lotShipCount,
    lotTitle,
    lotPrice,
    lotBid,
    lotTotal,
    lotTime,
    lot: null,
    lastWonLot: ''
  };

  audioBtn.addEventListener('click', () => setUnmuted(unmutedId === user.id ? null : user.id));
  lensBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLensPop(lensBtn); });
  viewBtn.addEventListener('click', () => applyView(tile, nextView(tile.gridView)));
  externalBtn.addEventListener('click', () => openInBrowser(tile.liveUrl));
  focusBtn.addEventListener('click', () => setFocus(focusedId === user.id ? null : user.id));
  shrinkBtn.addEventListener('click', () => setFocus(null));
  reloadBtn.addEventListener('click', () => { try { webview.loadURL(tile.liveUrl); } catch (err) {} });

  // Rechte Maustaste über der Kachelkopfzeile (der Bereich der Seite selbst
  // meldet sich über das Preload-Skript, siehe ipc-message)
  el.addEventListener('mousedown', (e) => {
    if (e.button === 2) beginRightPress(user.id, { x: e.clientX, y: e.clientY });
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  webview.addEventListener('ipc-message', (event) => {
    const info = event.args && event.args[0];
    // Ein leeres Los ist eine gueltige Meldung ("gerade nichts unter dem Hammer")
    // und muss vor der Leerpruefung durch
    if (event.channel === 'wnms-lot') { onLot(tile, info || null); return; }
    if (!info) return;

    const hostPoint = guestToHost(tile, info);
    if (event.channel === 'wnms-rdown') beginRightPress(user.id, hostPoint);
    else if (event.channel === 'wnms-rmove') moveRightPress(hostPoint);
    else if (event.channel === 'wnms-rup') endRightPress(hostPoint);
    else if (event.channel === 'wnms-lenson') { lensKeyDown = true; openLens(user.id, hostPoint); }
    else if (event.channel === 'wnms-lensoff') { lensKeyDown = false; closeLens(); }
    else if (event.channel === 'wnms-lensmove') {
      lastPointer.set(user.id, hostPoint);
      if (lensKeyDown && !lens) openLens(user.id, hostPoint);
      else moveLens(hostPoint);
    }
  });

  webview.addEventListener('dom-ready', () => {
    applyZoom(tile);
    try { webview.insertCSS(HIDE_SCROLLBARS_CSS); } catch (err) {}
    try { webview.setAudioMuted(unmutedId !== user.id); } catch (err) {}
    status.hidden = true;
    updateLiveState(tile);
    dismissCookies(tile);
    setTimeout(() => dismissCookies(tile), 2500); // Banner erscheint teils verzögert
    // Nach einem Neuladen ist die eingefügte CSS weg – "Nur Video" nachziehen
    tile.cleanKey = null;
    if (tile.view !== 'full') applyView(tile, tile.view, { force: true, quiet: true });
    try { webview.send('wnms-track', tile.id === focusedId); } catch (err) {}
    if (lens && lens.tileId === tile.id) sendLensMode(tile, true);
  });

  webview.addEventListener('did-navigate', () => updateLiveState(tile));
  webview.addEventListener('did-navigate-in-page', () => updateLiveState(tile));

  webview.addEventListener('did-start-loading', () => {
    status.hidden = false;
    status.textContent = 'Lädt …';
  });

  webview.addEventListener('did-stop-loading', () => { status.hidden = true; });

  webview.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return; // abgebrochene Navigation, kein echter Fehler
    status.hidden = false;
    status.textContent = 'Konnte nicht geladen werden (' + event.errorDescription + ')';
  });

  webview.addEventListener('render-process-gone', () => {
    status.hidden = false;
    status.textContent = 'Stream abgestürzt – wird neu geladen …';
    setTimeout(() => { try { webview.reload(); } catch (err) {} }, 1500);
  });

  return tile;
}

function updateTileHead(tile, user, state) {
  tile.nameEl.textContent = user.username;
  const parts = [];
  if (state.viewers) parts.push(state.viewers + ' Zuschauer');
  if (state.title) parts.push(state.title);
  tile.titleEl.textContent = parts.join(' · ');
  tile.titleEl.title = state.title || '';
}

// Fokussierte Kachel läuft in Originalgröße (Desktop-Layout zum Bieten),
// alle anderen verkleinert als Handy-Vorschau.
let zoomSeq = 0;

function applyZoom(tile) {
  const factor = tile.id === focusedId ? FOCUS_ZOOM : previewZoom;
  // Die laufende Nummer meldet die Seite zurueck, wenn sie den neuen Massstab
  // verdaut hat (siehe waitSettled) - eine verspaetete Meldung von vorhin
  // traegt eine alte Nummer und wird nicht mehr fuer bare Muenze genommen.
  tile.zoomSeq = ++zoomSeq;
  try { tile.webview.send('wnms-zoom', factor, tile.zoomSeq); } catch (err) { /* noch nicht bereit */ }
}

function currentUrl(tile) {
  try { return tile.webview.getURL() || ''; } catch (err) { return ''; }
}

function updateLiveState(tile) {
  tile.el.classList.toggle('is-live', isLiveUrl(currentUrl(tile)));
}

async function dismissCookies(tile) {
  try { await tile.webview.executeJavaScript(DISMISS_COOKIES_JS, true); } catch (err) {}
}

// Drei Ansichten je Kachel, im Kreis geschaltet:
//   full   - die Seite, wie Whatnot sie liefert
//   nochat - ohne Chat, aber mit Shop, Preis und Gebots-Schaltflaechen
//   video  - nur das Videobild
const VIEW_ORDER = ['full', 'nochat', 'video'];
const VIEW_LOOK = {
  full:   { icon: 'fa-comments',      title: 'Chat ausblenden' },
  nochat: { icon: 'fa-comment-slash', title: 'Chat ist aus – weiter zu: nur Video' },
  video:  { icon: 'fa-film',          title: 'Nur Video – weiter zu: ganze Seite' }
};

function nextView(view) {
  const at = VIEW_ORDER.indexOf(view);
  return VIEW_ORDER[(at + 1) % VIEW_ORDER.length];
}

/* Stellt eine Kachel auf eine der drei Ansichten.
 *
 * opts.force     - auch anwenden, wenn die Kachel schon so steht (nach Neuladen)
 * opts.quiet     - nicht sofort in die Ablage schreiben (der Aufrufer tut es)
 * opts.transient - nur fuer den Augenblick, nichts merken. Das ist der
 *                  Grossansicht vorbehalten: dort sind Chat und Oberflaeche
 *                  immer da, ohne dass die Einstellung des Rasters dabei
 *                  verlorenginge (siehe applyFocusState).
 */
async function applyView(tile, mode, opts) {
  const o = opts || {};
  if (!VIEW_LOOK[mode]) mode = 'full';
  if (tile.view === mode && !o.force) return;
  tile.view = mode;
  tile.el.classList.toggle('clean', mode === 'video');

  // Die Wahl gehoert zum Streamer, nicht zur Kachel - so steht sie beim
  // naechsten Start und nach jedem Neuaufbau der Kachel wieder da. Was die
  // Grossansicht kurzzeitig erzwingt, wird dagegen nicht gemerkt.
  if (!o.transient) {
    tile.gridView = mode;
    const user = users.find((entry) => entry.id === tile.id);
    if (user && user.view !== mode) {
      user.view = mode;
      if (!o.quiet) store(USERS_KEY, users);
    }
  }

  if (tile.viewBtn) {
    // Der Knopf zeigt immer den Rasterzustand - in der Grossansicht ist er
    // ohnehin ausgeblendet, dort gibt es nichts umzuschalten.
    const look = VIEW_LOOK[tile.gridView] || VIEW_LOOK.full;
    tile.viewBtn.replaceChildren(icon(look.icon));
    tile.viewBtn.title = look.title;
    tile.viewBtn.classList.toggle('on', tile.gridView !== 'full');
  }

  // Bei "nur Video" ist der Chat ohnehin weg - dann nicht doppelt eingreifen
  try { tile.webview.send('wnms-chat', mode === 'nochat'); } catch (err) {}

  try {
    if (mode === 'video') {
      if (!tile.cleanKey) tile.cleanKey = await tile.webview.insertCSS(CLEAN_VIDEO_CSS);
    } else if (tile.cleanKey) {
      await tile.webview.removeInsertedCSS(tile.cleanKey);
      tile.cleanKey = null;
    }
  } catch (err) { /* Seite gerade nicht bereit */ }
}

// Der Knopf oben schaltet alle Kacheln gemeinsam - und legt zugleich fest,
// womit neu auftauchende Kacheln starten.
function applyViewAll(mode) {
  if (!VIEW_LOOK[mode]) mode = 'full';
  settings.view = mode;

  for (const user of users) user.view = mode;
  store(USERS_KEY, users);
  saveSettings();

  for (const tile of tiles.values()) {
    // Die gross gezeigte Kachel behaelt Chat und Oberflaeche - gemerkt wird die
    // Wahl trotzdem, sie gilt wieder, sobald die Grossansicht endet.
    const inFocus = tile.id === focusedId;
    if (inFocus) tile.gridView = mode;
    applyView(tile, mode, { force: true, quiet: true, transient: inFocus });
  }
  renderViewAll();

  const wording = { full: 'Alle Kacheln: ganze Seite', nochat: 'Alle Kacheln: ohne Chat', video: 'Alle Kacheln: nur Video' };
  toast(wording[mode]);
}

function renderViewAll() {
  const mode = VIEW_LOOK[settings.view] ? settings.view : 'full';
  const look = VIEW_LOOK[mode];
  if (els.optView) els.optView.value = mode;
  els.viewAll.replaceChildren(icon(look.icon));
  els.viewAll.classList.toggle('on', mode !== 'full');
  els.viewAll.title = 'Bei allen: ' + { full: 'Chat ausblenden', nochat: 'nur Video zeigen', video: 'ganze Seite zeigen' }[mode];
}

/* ================= Los-Leiste =================
 *
 * Was gerade unter dem Hammer ist, meldet die Kachel selbst (siehe preload-tile.js).
 * Hier wird daraus die schmale Zeile am unteren Kachelrand - lesbar auch dann,
 * wenn die Kachel klein ist, denn sie gehoert zur App und nicht zur Seite.
 */

function isMe(name) {
  const me = (settings.me || '').trim().toLowerCase();
  return Boolean(me) && String(name || '').trim().toLowerCase() === me;
}

function formatRest(seconds) {
  if (seconds >= 60) return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  return seconds + ' s';
}

function onLot(tile, lot) {
  tile.lot = lot;

  // Zuschlag gefallen: Habe ich selbst gewonnen, laeuft der Versand bei diesem
  // Verkaeufer ab jetzt fuer heute - jedes weitere Los kostet keinen zweiten.
  if (lot && lot.done && lot.leader) {
    const key = lot.title + '|' + lot.leader;
    if (key !== tile.lastWonLot) {
      tile.lastWonLot = key;
      if (isMe(lot.leader)) {
        markShipping(tile.id, lot.shipping, false);
        const user = users.find((u) => u.id === tile.id);
        toast('Zuschlag bei ' + (user ? user.username : 'diesem Verkäufer') + ' – Versand läuft jetzt');
      }
    }
  }
  renderLot(tile);
}

function formatMoney(value, currency) {
  const text = Number(value).toFixed(2).replace('.', ',');
  return currency ? text + ' ' + currency : text;
}

/* Was das Los am Ende wirklich kostet.
 *
 * Gerechnet wird nur mit dem, was auf der Seite steht: dem naechsten Gebot und
 * den Versandkosten dieses Verkaeufers. Fehlt eines von beiden, kommt hier
 * nichts zurueck - eine geschaetzte Summe waere schlimmer als gar keine.
 *
 * Der Sonderfall ist die Buendelung: Ist bei diesem Verkaeufer heute schon ein
 * Zuschlag gefallen, faellt fuer das naechste Los kein zweiter Versand an. Dann
 * ist die Summe das Gebot selbst - und das wird auch so benannt.
 */
function totalWithShipping(tile, lot) {
  if (!settings.showTotal || !lot) return null;
  if (typeof lot.bidValue !== 'number' || !isFinite(lot.bidValue)) return null;

  const currency = lot.currency || '';
  const bundled = Boolean(shippingOf(tile.id));
  if (bundled) return { value: lot.bidValue, bundled: true, currency: currency };

  if (typeof lot.shippingValue !== 'number' || !isFinite(lot.shippingValue)) return null;
  return { value: lot.bidValue + lot.shippingValue, bundled: false, currency: currency };
}

function renderLot(tile) {
  const lot = tile.lot;
  const ship = shippingOf(tile.id);
  tile.lotBar.hidden = !settings.showLot || (!lot && !ship);
  if (tile.lotBar.hidden) return;

  tile.lotShip.hidden = !ship;
  if (ship) {
    tile.lotShipCount.textContent = ship.count > 1 ? '×' + ship.count : '';
    tile.lotShip.title = 'Versand läuft heute schon' + (ship.fee ? ' (' + ship.fee + ')' : '') +
      ' – weitere Lose bei diesem Verkäufer kosten keinen zweiten Versand.';
  }

  tile.lotTitle.textContent = lot ? lot.title : 'Versand läuft heute schon';
  tile.lotBid.textContent = lot ? lot.bid : '';
  tile.lotBid.hidden = !(lot && lot.bid);

  // Zweite Zeile unter dem Preis: was mit Versand zusammenkommt
  const total = totalWithShipping(tile, lot);
  tile.lotTotal.hidden = !total;
  if (total) {
    tile.lotTotal.textContent = 'inkl. Versand: ' + formatMoney(total.value, total.currency);
    tile.lotTotal.classList.toggle('bundled', total.bundled);
    tile.lotTotal.title = total.bundled
      ? 'Bei diesem Verkäufer läuft der Versand heute schon – für dieses Los kommt keiner mehr dazu.'
      : 'Nächstes Gebot ' + lot.bid + ' plus Versand ' + lot.shipping;
  }
  tile.lotPrice.hidden = tile.lotBid.hidden && tile.lotTotal.hidden;

  const rest = lot && typeof lot.rest === 'number' ? lot.rest : null;
  tile.lotTime.hidden = rest === null;
  tile.lotTime.textContent = rest === null ? '' : formatRest(rest);

  tile.lotBar.classList.toggle('ending', rest !== null && rest <= 10);
  tile.lotBar.classList.toggle('mine', Boolean(lot && isMe(lot.leader)));

  const parts = [];
  if (lot && lot.title) parts.push(lot.title);
  if (lot && lot.bid) parts.push('nächstes Gebot ' + lot.bid);
  if (total) parts.push('mit Versand ' + formatMoney(total.value, total.currency) + (total.bundled ? ' (gebündelt)' : ''));
  if (lot && lot.statusText) parts.push(lot.statusText);
  if (lot && lot.shipping) parts.push('Versand ' + lot.shipping);
  if (ship) parts.push('heute schon ' + ship.count + ' Zuschlag' + (ship.count > 1 ? 'e' : '') + ' – Versand läuft');
  tile.lotBar.title = parts.join(' · ');
}
/* ================= Lupe (nur in der Großansicht) =================
 *
 * Solange die Lupentaste gedrueckt ist, schwebt ueber der grossen Kachel ein
 * Glas, das dem Zeiger folgt. Die Kachel ist ein eigener Browser-View - der
 * Wirt kann ihren Inhalt also nicht einfach vergroessert nachzeichnen.
 * Stattdessen wird genau der Ausschnitt unter dem Glas abfotografiert
 * (capturePage mit Rechteck) und vergroessert eingesetzt.
 *
 * Der wunde Punkt einer gehaltenen Taste ist das Loslassen: Wandert der
 * Tastaturfokus dazwischen weg - von der Kachelseite ins App-Fenster, vom
 * Fenster in ein anderes Programm -, kommt das keyup nie an und die Lupe bliebe
 * stehen. Dagegen stehen drei Dinge:
 *
 *   1. Kachelseite und App-Fenster ziehen den Tastenzustand bei *jedem*
 *      Ereignis nach (getModifierState), nicht nur beim keyup.
 *   2. Jeder Fokusverlust beendet sie.
 *   3. Ein Waechter sieht regelmaessig nach, ob die Voraussetzungen ueberhaupt
 *      noch stimmen - fokussierte Kachel, Fenster im Vordergrund, Taste liegt.
 */

// Die zuletzt eingestellte Lupe wieder aufnehmen
let lensSize = clampLensSize(settings.lensSize || LENS_START_SIZE);
let lensMag = clampLensMag(settings.lensMag || LENS_START_MAG);
const lastPointer = new Map(); // tileId -> zuletzt gemeldete Zeigerposition
let lensKeyDown = false;       // liegt die Lupentaste gerade?
let lensGuard = null;

function clampLensSize(value) {
  return Math.min(LENS_MAX_SIZE, Math.max(LENS_MIN_SIZE, Math.round(Number(value) || LENS_START_SIZE)));
}

function clampLensMag(value) {
  const step = Math.round((Number(value) || LENS_START_MAG) * 2) / 2;
  return Math.min(LENS_MAX_MAG, Math.max(LENS_MIN_MAG, step));
}

function tileCenter(tile) {
  const rect = tile.el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function sendLensMode(tile, on) {
  try { tile.webview.send('wnms-lens', on); } catch (err) {}
}

// Nur die grosse Kachel meldet dauerhaft, wo der Zeiger steht
function setPointerTracking() {
  for (const [id, tile] of tiles) {
    try { tile.webview.send('wnms-track', id === focusedId); } catch (err) {}
  }
}

function openLens(tileId, point) {
  if (point) lastPointer.set(tileId, point);
  if (lens) {
    if (lens.tileId === tileId && point) moveLens(point);
    return;
  }
  if (focusedId !== tileId) return; // die Lupe gehoert in die Grossansicht

  const tile = tiles.get(tileId);
  // Ist noch nie eine Zeigerposition gemeldet worden - etwa weil die Maus seit
  // dem Vergroessern nicht bewegt wurde -, faengt die Lupe in der Kachelmitte
  // an. Sie springt beim ersten Wackeln an die richtige Stelle; das ist besser,
  // als auf einen Tastendruck gar nicht zu reagieren.
  const where = point || lastPointer.get(tileId) || (tile ? tileCenter(tile) : null);
  if (!tile || !where) return;
  if (typeof tile.webview.capturePage !== 'function') {
    toast('Lupe wird von dieser Electron-Fassung nicht unterstützt');
    return;
  }

  lens = {
    tileId: tileId,
    x: where.x,
    y: where.y,
    busy: false,
    timer: setInterval(captureLens, LENS_FRAME_MS)
  };
  els.lens.hidden = false;
  drawLens();
  captureLens();
  sendLensMode(tile, true);
  startLensGuard();
}

function closeLens() {
  lensKeyDown = false;
  stopLensGuard();
  if (!lens) return;
  clearInterval(lens.timer);
  const tile = tiles.get(lens.tileId);
  lens = null;
  els.lens.hidden = true;
  els.lensImage.removeAttribute('src');
  if (tile) sendLensMode(tile, false);
}

function moveLens(point) {
  if (!lens) return;
  lens.x = point.x;
  lens.y = point.y;
  drawLens();
}

/* Der Waechter. Er stellt keine Vermutungen an, sondern prueft die drei
 * Bedingungen, unter denen die Lupe ueberhaupt zu sehen sein darf. Faellt eine
 * weg - die Kachel ist nicht mehr gross, das Fenster nicht mehr vorn, die
 * Kachel gar nicht mehr da -, ist sofort Schluss. Damit kann sie nicht haengen
 * bleiben, auch wenn irgendwo ein Loslassen verlorengeht. */
function startLensGuard() {
  if (lensGuard) return;
  lensGuard = setInterval(() => {
    if (!lens) { stopLensGuard(); return; }
    const gone = !tiles.has(lens.tileId) || lens.tileId !== focusedId;
    const away = !document.hasFocus() && !lensKeyDown;
    if (gone || away || document.hidden) closeLens();
  }, LENS_GUARD_MS);
}

function stopLensGuard() {
  clearInterval(lensGuard);
  lensGuard = null;
}

function setLensSize(value, quiet) {
  lensSize = clampLensSize(value);
  settings.lensSize = lensSize;
  if (!quiet) saveSettings();
  drawLens();
  renderLensControls();
}

function setLensMag(value, quiet) {
  lensMag = clampLensMag(value);
  settings.lensMag = lensMag;
  if (!quiet) saveSettings();
  drawLens();
  renderLensControls();
}

function drawLens() {
  if (!lens) return;
  const stage = els.stage.getBoundingClientRect();
  els.lens.style.width = lensSize + 'px';
  els.lens.style.height = lensSize + 'px';
  els.lens.style.left = (lens.x - stage.left - lensSize / 2) + 'px';
  els.lens.style.top = (lens.y - stage.top - lensSize / 2) + 'px';
  els.lensLabel.textContent = lensMag.toFixed(1).replace('.', ',') + '×';
}

// Nur der benoetigte Bereich wird abfotografiert, nicht die ganze Seite -
// das haelt die Sache bezahlbar.
async function captureLens() {
  if (!lens || lens.busy) return;
  const tile = tiles.get(lens.tileId);
  if (!tile) { closeLens(); return; }

  lens.busy = true;
  try {
    const rect = tile.webview.getBoundingClientRect();
    const src = Math.max(24, Math.round(lensSize / lensMag));
    const maxX = Math.max(0, Math.round(rect.width) - src);
    const maxY = Math.max(0, Math.round(rect.height) - src);
    const area = {
      x: Math.min(Math.max(0, Math.round(lens.x - rect.left - src / 2)), maxX),
      y: Math.min(Math.max(0, Math.round(lens.y - rect.top - src / 2)), maxY),
      width: src,
      height: src
    };
    const shot = await tile.webview.capturePage(area);
    if (lens) els.lensImage.src = shot.toDataURL();
  } catch (err) { /* Kachel gerade nicht greifbar */ }
  if (lens) lens.busy = false;
}

/* ---- Der Lupenknopf in der Großansicht ----
 * Ein Klick zeigt, auf welcher Taste die Lupe liegt, und laesst Glasgroesse und
 * Vergroesserung einstellen - dafuer gab es frueher das Mausrad. */

function renderLensControls() {
  const sizeText = lensSize + ' px';
  const magText = lensMag.toFixed(1).replace('.', ',') + '×';

  if (els.lensPopSize) els.lensPopSize.value = String(lensSize);
  if (els.lensPopMag) els.lensPopMag.value = String(lensMag);
  if (els.lensPopSizeOut) els.lensPopSizeOut.textContent = sizeText;
  if (els.lensPopMagOut) els.lensPopMagOut.textContent = magText;

  if (els.optLensSize) els.optLensSize.value = String(lensSize);
  if (els.optLensMag) els.optLensMag.value = String(lensMag);
  if (els.optLensSizeOut) els.optLensSizeOut.textContent = sizeText;
  if (els.optLensMagOut) els.optLensMagOut.textContent = magText;
}

function openLensPop(anchor) {
  renderLensControls();
  els.lensPop.hidden = false;
  const box = anchor.getBoundingClientRect();
  const pop = els.lensPop.getBoundingClientRect();
  const left = Math.min(box.left + box.width / 2 - pop.width / 2, window.innerWidth - pop.width - 8);
  els.lensPop.style.left = Math.max(8, left) + 'px';
  els.lensPop.style.top = Math.min(box.bottom + 8, window.innerHeight - pop.height - 8) + 'px';
}

function closeLensPop() {
  els.lensPop.hidden = true;
}

function toggleLensPop(anchor) {
  if (els.lensPop.hidden) openLensPop(anchor);
  else closeLensPop();
}

/* ================= Zustand -> Raster ================= */

// Angezeigt wird, wer gerade live und nicht versteckt ist.
function visibleUsers() {
  return users
    .filter((user) => !user.hidden && stateOf(user).live && stateOf(user).liveUrl)
    .slice(0, MAX_TILES);
}

function hiddenLiveUsers() {
  return users.filter((user) => user.hidden && stateOf(user).live);
}

function syncTiles() {
  if (locked) return;
  const wanted = visibleUsers();
  const wantedIds = new Set(wanted.map((user) => user.id));

  for (const [id, tile] of tiles) {
    if (wantedIds.has(id)) continue;
    if (lens && lens.tileId === id) closeLens();
    lastPointer.delete(id);
    tile.el.remove();
    tiles.delete(id);
    if (unmutedId === id) unmutedId = null;
    if (unmutedBeforeFocus === id) unmutedBeforeFocus = null;
    if (focusedId === id) focusedId = null;
  }

  for (const user of wanted) {
    const state = stateOf(user);
    let tile = tiles.get(user.id);
    if (!tile) {
      tile = createTile(user, state);
      tiles.set(user.id, tile);
      els.grid.appendChild(tile.el);
    } else if (tile.liveUrl !== state.liveUrl) {
      // Der Streamer hat eine neue Show gestartet - Kachel nachziehen
      tile.liveUrl = state.liveUrl;
      try { tile.webview.loadURL(state.liveUrl); } catch (err) {}
    }
    updateTileHead(tile, user, state);
    renderLot(tile); // Versand-Merker steht ggf. schon, bevor ein Los gemeldet wird
  }

  // Der zuletzt gewaehlte Ton wird wieder aufgenommen, sobald seine Kachel da ist
  const soundTile = unmutedId ? tiles.get(unmutedId) : null;
  if (soundTile && !soundTile.el.classList.contains('audio-on')) setUnmuted(unmutedId);

  const liveCount = users.filter((user) => stateOf(user).live).length;
  els.count.textContent = liveCount + ' live · ' + users.length + ' User';
  updateEmptyState();
  updateHiddenButton();
  applyOrder();
  layout();
}

// Sucht die Spaltenzahl, bei der das (hochkante) Streambild am groessten wird.
function bestColumns(n, aspect) {
  const stageW = els.grid.clientWidth || 1200;
  const stageH = els.grid.clientHeight || 700;
  let best = 1;
  let bestArea = -1;

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = stageW / cols - TILE_GAP;
    const cellH = stageH / rows - TILE_GAP;
    if (cellW <= 0 || cellH <= 0) continue;
    // Groesse des Videos, das in diese Kachel passt
    const w = Math.min(cellW, cellH * aspect);
    const area = w * (w / aspect);
    if (area > bestArea + 1) { bestArea = area; best = cols; }
  }
  return best;
}

// Massstab so waehlen, dass die Seite in der Kachel genau TILE_BASE_WIDTH
// logische Pixel breit ist. Die Kachel ist im Handy-Format, also ergibt sich
// die Hoehe von selbst - die Seite sieht in jeder Kachelgroesse gleich aus.
function setPreviewZoom(tileWidth) {
  const next = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, tileWidth / TILE_BASE_WIDTH));
  if (Math.abs(next - previewZoom) < 0.01) return;
  previewZoom = next;
  for (const tile of tiles.values()) applyZoom(tile);
}

function setTileSize(width, height) {
  els.grid.style.setProperty('--tile-w', Math.max(80, Math.floor(width)) + 'px');
  els.grid.style.setProperty('--tile-h', Math.max(140, Math.floor(height)) + 'px');
}

function layout() {
  const n = Math.max(tiles.size, 1);
  const manual = !focusedId && settings.cols !== 'auto';
  let cols;
  if (focusedId) {
    cols = 1;
  } else if (manual) {
    cols = Number(settings.cols);
  } else {
    cols = bestColumns(n, PORTRAIT_ASPECT);
  }
  const rows = focusedId ? 1 : Math.ceil(n / cols);

  els.grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
  els.grid.classList.toggle('manual', manual);

  // Kachelgröße in Pixeln vorgeben. Ohne feste Größe nähmen die zentrierten
  // Kacheln die Eigenbreite des webviews (300 px) statt der Spaltenbreite an.
  const stageW = els.grid.clientWidth || 1200;
  const stageH = els.grid.clientHeight || 700;
  const cellW = (stageW - (cols + 1) * TILE_GAP) / cols;

  if (manual) {
    // Feste Spaltenzahl: Kachel füllt die Spalte, Höhe folgt dem Handy-Format.
    // Passt nicht alles ins Fenster, wird gescrollt.
    const tileH = Math.max(160, cellW / PORTRAIT_ASPECT);
    els.grid.style.gridTemplateRows = '';
    els.grid.style.gridAutoRows = tileH + 'px';
    if (!focusedId) { setTileSize(cellW, tileH); setPreviewZoom(cellW); }
  } else {
    const cellH = (stageH - (rows + 1) * TILE_GAP) / rows;
    const tileW = Math.min(cellW, cellH * PORTRAIT_ASPECT);
    els.grid.style.gridAutoRows = '';
    els.grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    // Im Fokus bleibt --tile-w/h auf der Vorschaugroesse stehen: die abgelegten
    // Kacheln behalten damit ihre Masse und bauen ihr Layout nicht um.
    if (!focusedId) { setTileSize(tileW, tileW / PORTRAIT_ASPECT); setPreviewZoom(tileW); }
  }
  // Im Raster Handy-Format, im Fokus die volle Fensterfläche (Desktop-Ansicht)
  els.grid.classList.toggle('portrait', !focusedId);
  els.grid.classList.toggle('focus-mode', Boolean(focusedId));

  for (const [id, tile] of tiles) {
    const isFocused = id === focusedId;
    tile.el.classList.toggle('focused', isFocused);
    // Im Fokus zeigt die Kachel das Verkleinern-Symbol statt des Vergrößerns
    tile.shrinkBtn.hidden = !isFocused;
    tile.focusBtn.hidden = isFocused;
    // Chat und Oberflaeche lassen sich nur im Raster umschalten - in der
    // Grossansicht sind sie immer da, der Knopf haette dort nichts zu tun.
    tile.viewBtn.hidden = isFocused;
    // Die Lupe gibt es nur in der Grossansicht, also auch ihr Knopf nur dort
    tile.lensBtn.hidden = !isFocused;
  }

  // Derselbe Grund fuer den Knopf oben: er stellt das Raster ein
  els.viewAll.hidden = Boolean(focusedId);
}

/* ================= Rechte Maustaste: Menü und Umsortieren ================= */

const DRAG_THRESHOLD = 6; // Pixel, ab denen aus dem Klick ein Ziehen wird
let rightPress = null;    // { id, start, moved }

// Koordinaten aus der Kachelseite in Fensterkoordinaten umrechnen
function guestToHost(tile, point) {
  const rect = tile.webview.getBoundingClientRect();
  const zoom = tile.id === focusedId ? FOCUS_ZOOM : previewZoom;
  return { x: rect.left + point.x * zoom, y: rect.top + point.y * zoom };
}

function beginRightPress(id, point) {
  closeTileMenu();
  rightPress = { id, start: point, moved: false };
}

function moveRightPress(point) {
  if (!rightPress) return;
  const dx = point.x - rightPress.start.x;
  const dy = point.y - rightPress.start.y;

  if (!rightPress.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    rightPress.moved = true;
    const tile = tiles.get(rightPress.id);
    if (tile) tile.el.classList.add('dragging');
    // Overlay fängt ab jetzt die Mausbewegung ab, damit sie nicht in den Kacheln versackt
    els.dragOverlay.hidden = false;
  }
  if (rightPress.moved) reorderTo(rightPress.id, point);
}

function endRightPress(point) {
  if (!rightPress) return;
  const { id, moved } = rightPress;
  rightPress = null;
  els.dragOverlay.hidden = true;

  const tile = tiles.get(id);
  if (tile) tile.el.classList.remove('dragging');

  if (moved) {
    store(USERS_KEY, users);
    renderUserList();
  } else {
    openTileMenu(id, point);
  }
}

// Kachel an die Position schieben, über der die Maus gerade steht
function reorderTo(id, point) {
  const from = users.findIndex((user) => user.id === id);
  if (from < 0) return;

  let targetId = id;
  let bestDistance = Infinity;
  for (const [tileId, tile] of tiles) {
    const rect = tile.el.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - point.x;
    const dy = rect.top + rect.height / 2 - point.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) { bestDistance = distance; targetId = tileId; }
  }

  const target = users.findIndex((user) => user.id === targetId);
  if (target < 0 || target === from) return;
  const [moved] = users.splice(from, 1);
  users.splice(target, 0, moved);
  applyOrder();
}

// Reihenfolge nur über CSS setzen – ein Verschieben im DOM würde die
// webviews neu aufbauen und damit alle Streams neu laden.
function applyOrder() {
  users.forEach((user, index) => {
    const tile = tiles.get(user.id);
    if (tile) tile.el.style.order = String(index);
  });
}

function openTileMenu(id, point) {
  const user = users.find((entry) => entry.id === id);
  const tile = tiles.get(id);
  if (!user || !tile) return;
  els.menu.dataset.id = id;
  els.menuTitle.textContent = user.username;

  // In der Grossansicht sind Chat und Oberflaeche gesetzt - die beiden
  // Umschalter waeren dort wirkungslos und stehen deshalb gar nicht erst da.
  const inFocus = id === focusedId;
  for (const action of ['chat', 'clean']) {
    const entry = els.menu.querySelector('[data-action="' + action + '"]');
    if (entry) entry.hidden = inFocus;
  }

  const chatLabel = els.menu.querySelector('[data-role="chat-label"]');
  if (chatLabel) chatLabel.textContent = tile.gridView === 'nochat' ? 'Chat wieder zeigen' : 'Chat ausblenden';
  const cleanLabel = els.menu.querySelector('[data-role="clean-label"]');
  if (cleanLabel) cleanLabel.textContent = tile.gridView === 'video' ? 'Ganze Seite zeigen' : 'Nur Video zeigen';
  const shipLabel = els.menu.querySelector('[data-role="ship-label"]');
  if (shipLabel) shipLabel.textContent = shippingOf(id) ? 'Versand-Merker entfernen' : 'Versand läuft heute schon';
  els.menu.hidden = false;
  // im Fenster halten
  const rect = els.menu.getBoundingClientRect();
  const x = Math.min(point.x, window.innerWidth - rect.width - 8);
  const y = Math.min(point.y, window.innerHeight - rect.height - 8);
  els.menu.style.left = Math.max(8, x) + 'px';
  els.menu.style.top = Math.max(8, y) + 'px';
}

function closeTileMenu() {
  els.menu.hidden = true;
  els.menu.dataset.id = '';
}

/* ================= Wechsel zwischen Raster und großem Modus =================
 *
 * Beim Vergrößern ändern sich zwei Dinge auf einmal: die Kachel wird zur ganzen
 * Bühne, und die Seite läuft ab jetzt in Originalgröße statt verkleinert.
 * Whatnot baut daraufhin sein Layout um – vom Handy-Format mit Chat unter dem
 * Bild auf die Desktop-Ansicht. Dieser Umbau dauert ein paar Bilder und sieht
 * roh aus: Kästen springen, Bilder laden nach.
 *
 * Deshalb passiert der Umbau hinter einem Vorhang. Von der Kachel wird ein
 * Standbild gezogen, ein Deckel legt sich über die Bühne, das Standbild fährt
 * in die neue Größe – und erst wenn die Seite darunter fertig ist, blendet
 * alles weg. Zu sehen ist nur eine Kachel, die wächst bzw. schrumpft.
 */

let morphToken = 0;    // laufende Nummer, damit ein neuer Wechsel den alten abloest
let morphBusy = false;
let morphTarget = null;

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (err) { return false; }
}

// Lage eines Elements in Buehnenkoordinaten - der Deckel liegt ueber der Buehne
function stageBox(el) {
  const rect = el.getBoundingClientRect();
  const stage = els.stage.getBoundingClientRect();
  return {
    left: rect.left - stage.left,
    top: rect.top - stage.top,
    width: rect.width,
    height: rect.height
  };
}

function boxStyle(box) {
  return {
    left: box.left + 'px',
    top: box.top + 'px',
    width: box.width + 'px',
    height: box.height + 'px'
  };
}

// Grosse Kacheln liefern ein entsprechend grosses Bild - als Datenadresse waeren
// das schnell mehrere Megabyte, die der Wirt erst wieder entpacken muesste.
// Fuer ein Standbild, das eine halbe Sekunde zu sehen ist, reicht weniger.
const MORPH_SHOT_MAX_W = 1280;

async function shootTile(tile) {
  try {
    let image = await tile.webview.capturePage();
    if (!image || image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width > MORPH_SHOT_MAX_W) image = image.resize({ width: MORPH_SHOT_MAX_W });
    return image.toDataURL();
  } catch (err) { return null; }
}

// Die Kachelseite meldet sich, sobald sie den neuen Massstab verarbeitet hat.
// Bleibt die Meldung aus (Seite haengt, Preload noch nicht da), wird nach
// laengstens `timeout` weitergemacht.
function waitSettled(tile, timeout) {
  return new Promise((resolve) => {
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { tile.webview.removeEventListener('ipc-message', onMessage); } catch (err) {}
      resolve();
    }
    function onMessage(event) {
      if (event.channel !== 'wnms-zoomed') return;
      const info = event.args && event.args[0];
      // Nur die Meldung zu genau diesem Massstabswechsel zaehlt - eine aeltere
      // (etwa nach einer Fenstergroessenaenderung von vorhin) wuerde den Deckel
      // zu frueh anheben.
      if (!info || info.seq !== tile.zoomSeq) return;
      finish();
    }
    const timer = setTimeout(finish, timeout);
    try { tile.webview.addEventListener('ipc-message', onMessage); } catch (err) { finish(); }
  });
}

function cancelMorphAnimations() {
  for (const el of [els.morph, els.morphShot, els.morphBusy]) {
    try { el.getAnimations().forEach((anim) => anim.cancel()); } catch (err) {}
  }
}

// Der Puffer sitzt in der Mitte des Standbilds, nicht in der Buehnenmitte
function placeBusy(box) {
  els.morphBusy.style.left = (box.left + box.width / 2) + 'px';
  els.morphBusy.style.top = (box.top + box.height / 2) + 'px';
}

function endMorph() {
  cancelMorphAnimations();
  els.morph.hidden = true;
  els.morphShot.style.filter = '';
  els.morphShot.removeAttribute('src');
  els.morphBusy.style.opacity = '0';
  els.morph.style.opacity = '';
}

// Laeuft dieser Wechsel noch? Ein neuer Klick oder eine beendete Show brechen ab.
function morphAlive(token, tile) {
  if (token !== morphToken) return false; // ein neuer Wechsel hat uebernommen
  if (tiles.has(tile.id)) return true;
  endMorph();                             // Show ist inzwischen zu Ende
  return false;
}

// Der eigentliche Zustandswechsel - ohne ihn saehe man den Umbau der Seite.
function applyFocusState(id) {
  // Beim Vergrößern läuft der Ton dieser Show, beim Verkleinern wieder der
  // Zustand von vorher – meist also wieder alles stumm.
  if (id && !focusedId) unmutedBeforeFocus = unmutedId;
  const before = focusedId;
  focusedId = id;
  closeLens();     // die Lupe gehoert immer nur zur gerade grossen Kachel
  closeLensPop();

  /* In der Grossansicht sind Chat und Oberflaeche da - dort will man bieten,
   * lesen und schreiben. Das ueberschreibt aber nicht, was fuer das Raster
   * eingestellt ist: gesetzt wird nur der Augenblickszustand (transient), und
   * beim Verlassen kommt genau der gemerkte Rasterzustand zurueck. */
  if (before && before !== id) {
    const back = tiles.get(before);
    if (back) applyView(back, back.gridView, { force: true, quiet: true, transient: true });
  }
  if (id) {
    const tile = tiles.get(id);
    if (tile) applyView(tile, 'full', { force: true, quiet: true, transient: true });
  }

  layout();
  for (const tile of tiles.values()) applyZoom(tile);
  setPointerTracking();
  if (id) {
    setUnmuted(id);
  } else {
    setUnmuted(unmutedBeforeFocus);
    unmutedBeforeFocus = null;
  }
}

async function setFocus(id) {
  // Waehrend eines Wechsels zaehlt dessen Ziel, nicht der noch alte Zustand
  if (morphBusy ? morphTarget === id : focusedId === id) return;

  const tile = tiles.get(id || focusedId);
  const token = ++morphToken;
  morphTarget = id;

  // Ohne Kachel oder ohne capturePage bleibt nur der harte Wechsel.
  // Abgeschaltete Systemanimationen sind dagegen kein Grund, das Standbild
  // wegzulassen - es verbirgt ja gerade das Zappeln. Bewegt wird dann nur
  // nichts mehr: es springt in die neue Groesse, statt zu fahren.
  if (!tile || typeof tile.webview.capturePage !== 'function') {
    morphBusy = false;
    morphTarget = null;
    endMorph();
    applyFocusState(id);
    return;
  }

  morphBusy = true;
  const glide = !reducedMotion();
  let applied = false;
  let busyTimer = null;
  const guard = setTimeout(() => {
    if (token !== morphToken) return;
    morphToken++;            // die laufende Kette bricht beim naechsten Schritt ab
    if (!applied) applyFocusState(id);
    endMorph();
    morphBusy = false;
    morphTarget = null;
  }, MORPH_MAX_MS);

  try {
    closeLens(); // die Lupe gehoert nicht in den Uebergang

    const from = stageBox(tile.el);
    const shot = await shootTile(tile);
    if (!morphAlive(token, tile)) return;
    if (!shot) { applyFocusState(id); applied = true; endMorph(); return; }

    // Das Standbild deckt genau diese Kachel ab - es ist deckungsgleich mit
    // dem, was gerade zu sehen war, also faellt das Aufsetzen nicht auf.
    cancelMorphAnimations();
    els.morphShot.src = shot;
    els.morphShot.style.filter = '';
    els.morphBusy.style.opacity = '0';
    Object.assign(els.morphShot.style, boxStyle(from));
    placeBusy(from);
    els.morph.hidden = false;
    els.morph.style.opacity = '1';
    // Moeglichst erst zeigen, wenn das Bild da ist - decode() kann in einem
    // unsichtbaren Fenster aber nie antworten, deshalb mit Frist.
    await Promise.race([els.morphShot.decode().catch(() => {}), sleep(200)]);
    if (!morphAlive(token, tile)) return;

    // Umschalten - der Umbau dieser einen Kachel passiert jetzt unsichtbar,
    // alle anderen Kacheln bleiben die ganze Zeit sichtbar.
    applyFocusState(id);
    applied = true;
    const to = stageBox(tile.el);

    // Zieht sich der Umbau, kommt der kleine Puffer dazu
    busyTimer = setTimeout(() => {
      placeBusy(to);
      els.morphBusy.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: 'forwards' });
    }, MORPH_BUSY_MS);

    // Standbild in die neue Groesse bringen und warten, bis die Seite darunter
    // meldet, dass Layout und Video wieder stehen.
    const settled = waitSettled(tile, MORPH_SETTLE_MS);
    if (glide) {
      await Promise.all([
        els.morphShot.animate(
          [boxStyle(from), boxStyle(to)],
          { duration: MORPH_MOVE_MS, easing: MORPH_EASE, fill: 'forwards' }
        ).finished,
        settled
      ]);
    } else {
      Object.assign(els.morphShot.style, boxStyle(to));
      await settled;
    }
    if (!morphAlive(token, tile)) return;

    // Puffer zuerst weg, dann das Standbild - der leichte Weichzeichner
    // verdeckt, dass ein vergroessertes Standbild nicht so scharf ist wie die
    // Seite darunter.
    clearTimeout(busyTimer);
    busyTimer = null;
    els.morphBusy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' });
    els.morphShot.animate(
      [{ filter: 'blur(0px)' }, { filter: 'blur(6px)' }],
      { duration: MORPH_FADE_MS, easing: 'linear', fill: 'forwards' }
    );
    await els.morph.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: MORPH_FADE_MS, fill: 'forwards' }
    ).finished;
    if (!morphAlive(token, tile)) return;
    endMorph();
  } finally {
    clearTimeout(guard);
    clearTimeout(busyTimer);
    if (token === morphToken) {
      morphBusy = false;
      morphTarget = null;
    }
  }
}

function setUnmuted(id) {
  unmutedId = id;
  if (settings.unmuted !== (id || null)) {
    settings.unmuted = id || null;
    saveSettings();
  }
  for (const [tileId, tile] of tiles) {
    const on = tileId === id;
    try { tile.webview.setAudioMuted(!on); } catch (err) {}
    tile.audioBtn.replaceChildren(icon(on ? 'fa-volume-high' : 'fa-volume-xmark'));
    tile.audioBtn.title = on ? 'Stummschalten' : 'Ton für diesen Stream einschalten';
    tile.audioBtn.classList.toggle('on', on);
    tile.el.classList.toggle('audio-on', on);
  }
}

/* ================= User verwalten ================= */

// Akzeptiert "voltico", "@voltico" und ganze Profil-Links.
function parseUsername(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  const hit = value.match(/whatnot\.com\/(?:[a-z]{2}-[a-z]{2}\/)?user\/([^/?#]+)/i);
  if (hit) value = hit[1];
  value = value.replace(/^@/, '').replace(/[/?#\s].*$/, '').trim();
  try { value = decodeURIComponent(value); } catch (err) { /* roh nehmen */ }
  return value;
}

// Eine ganze Liste auf einmal: "user1, user2, user3" - so, wie sie der Knopf
// "Liste kopieren" ausgibt. Getrennt wird an Komma, Semikolon, Zeilenumbruch
// und Leerzeichen, damit auch grob eingefuegte Listen durchgehen.
function splitList(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((part) => parseUsername(part))
    .filter(Boolean);
}

// Liefert, was passiert ist - der Aufrufer meldet es dem Nutzer.
function addUsers(raw, hidden) {
  const wanted = splitList(raw);
  const result = { added: [], double: [], full: 0 };
  if (!wanted.length) return result;

  const known = {};
  for (const user of users) known[user.username.toLowerCase()] = true;

  for (const username of wanted) {
    const key = username.toLowerCase();
    if (known[key]) { result.double.push(username); continue; }   // Doppelte still uebergehen
    if (users.length >= MAX_USERS) { result.full++; continue; }
    known[key] = true;
    const user = makeUser(username, hidden);
    users.push(user);
    result.added.push(user);
  }

  if (result.added.length) {
    store(USERS_KEY, users);
    renderUserList();
    syncTiles();
    for (const user of result.added) checkUser(user);
  } else if (result.double.length) {
    renderUserList();
  }
  return result;
}

function addUser(raw, hidden) {
  const result = addUsers(raw, hidden);
  return result.added.length > 0;
}

function removeUser(id) {
  const user = users.find((entry) => entry.id === id);
  users = users.filter((entry) => entry.id !== id);
  states.delete(id);
  store(USERS_KEY, users);
  syncTiles();
  renderUserList();
  if (user) toast(user.username + ' entfernt');
}

function setHidden(id, hidden) {
  const user = users.find((entry) => entry.id === id);
  if (!user) return;
  user.hidden = Boolean(hidden);
  store(USERS_KEY, users);
  syncTiles();
  renderUserList();
  if (user.hidden && stateOf(user).live) toast(user.username + ' versteckt – läuft weiter');
}

function describe(user) {
  const state = stateOf(user);
  if (state.error) return 'Prüfung fehlgeschlagen: ' + state.error;
  if (state.missing) return 'Profil nicht gefunden';
  if (state.live) {
    const bits = ['Live'];
    if (state.viewers) bits.push(state.viewers + ' Zuschauer');
    if (state.title) bits.push(state.title);
    return bits.join(' · ');
  }
  if (!state.lastCheck) return 'wird geprüft …';
  if (state.nextStart) {
    const when = new Date(state.nextStart);
    return 'Offline · nächste Show ' + when.toLocaleString('de-DE', {
      weekday: 'short', hour: '2-digit', minute: '2-digit'
    });
  }
  return 'Offline';
}

function avatarFor(user) {
  const box = document.createElement('span');
  box.className = 'avatar';
  box.textContent = (user.username || '?').slice(0, 1);
  if (user.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = user.avatar;
    // Laedt das Bild nicht, bleibt der Anfangsbuchstabe stehen
    img.addEventListener('error', () => img.remove());
    box.appendChild(img);
  }
  return box;
}

function rowButton(parent, iconName, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.appendChild(icon(iconName));
  button.addEventListener('click', onClick);
  parent.appendChild(button);
  return button;
}

function renderUserList() {
  updateHiddenButton();
  els.userList.textContent = '';

  const liveCount = users.filter((user) => stateOf(user).live).length;
  els.panelCount.textContent = users.length
    ? users.length + ' Streamer · ' + liveCount + ' live'
    : '';

  if (!users.length) {
    const hint = document.createElement('p');
    hint.className = 'panel-hint';
    hint.textContent = 'Noch keine Streamer eingetragen. Trag oben einen Namen ein – oder gleich eine ganze Liste.';
    els.userList.appendChild(hint);
    return;
  }

  for (const user of users) {
    const state = stateOf(user);

    const row = document.createElement('div');
    row.className = 'user-row';
    if (user.hidden) row.classList.add('is-hidden');
    if (state.live) row.classList.add('is-live');

    const main = document.createElement('div');
    main.className = 'user-main';

    const nameLine = document.createElement('div');
    nameLine.className = 'user-name';
    const name = document.createElement('strong');
    name.textContent = user.username;
    nameLine.appendChild(name);

    if (state.live) {
      const tag = document.createElement('span');
      tag.className = 'live-tag';
      tag.appendChild(icon('fa-circle'));
      tag.append(document.createTextNode('LIVE'));
      nameLine.appendChild(tag);
    }

    const ship = shippingOf(user.id);
    if (ship) {
      const badge = document.createElement('span');
      badge.className = 'row-ship';
      badge.appendChild(icon('fa-truck-fast'));
      badge.append(document.createTextNode(ship.count > 1 ? ' ×' + ship.count : ''));
      badge.title = 'Versand läuft heute schon' + (ship.fee ? ' (' + ship.fee + ')' : '') +
        ' – weitere Lose kosten hier keinen zweiten Versand.';
      nameLine.appendChild(badge);
    }

    const sub = document.createElement('span');
    sub.className = 'user-sub' + (state.error || state.missing ? ' err' : '');
    sub.textContent = describe(user);
    sub.title = sub.textContent;

    main.append(nameLine, sub);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    rowButton(actions, 'fa-arrow-up-right-from-square', 'Profil im Browser öffnen',
      () => openInBrowser(profileUrl(user.username)));

    const hideBtn = rowButton(actions, user.hidden ? 'fa-eye-slash' : 'fa-eye',
      user.hidden ? 'Wird nicht im Raster gezeigt – einblenden' : 'Verstecken: wird weiter geprüft, aber nicht angezeigt',
      () => setHidden(user.id, !user.hidden));
    hideBtn.classList.toggle('on', Boolean(user.hidden));

    const removeBtn = rowButton(actions, 'fa-trash', 'User entfernen', () => removeUser(user.id));
    removeBtn.classList.add('danger');

    row.append(avatarFor(user), main, actions);
    els.userList.appendChild(row);
  }
}

/* ================= Versteckte Live-Streams ================= */

function updateHiddenButton() {
  const live = hiddenLiveUsers();
  els.hiddenBtn.hidden = !users.some((user) => user.hidden);
  els.hiddenCount.textContent = String(live.length);
  els.hiddenBtn.classList.toggle('has-live', live.length > 0);
  els.hiddenBtn.title = live.length
    ? live.length + ' versteckte Show(s) laufen gerade'
    : 'Versteckte Streamer – gerade ist keiner live';
  if (!els.hiddenPop.hidden) renderHiddenPop();
}

function renderHiddenPop() {
  els.hiddenList.textContent = '';
  const live = hiddenLiveUsers();

  if (!live.length) {
    const hint = document.createElement('p');
    hint.className = 'panel-hint';
    hint.textContent = 'Gerade ist keiner der versteckten Streamer live.';
    els.hiddenList.appendChild(hint);
    return;
  }

  for (const user of live) {
    const state = stateOf(user);

    const card = document.createElement('button');
    card.className = 'hidden-card';
    card.title = 'Wieder im Raster anzeigen';

    const thumb = document.createElement('div');
    thumb.className = 'hidden-thumb';
    if (state.thumb) {
      const img = document.createElement('img');
      img.src = state.thumb;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.appendChild(icon('fa-video'));
    }

    const badge = document.createElement('span');
    badge.className = 'hidden-live';
    badge.textContent = state.viewers ? 'Live · ' + state.viewers : 'Live';
    thumb.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'hidden-meta';

    const name = document.createElement('strong');
    name.textContent = user.username;

    const title = document.createElement('span');
    title.textContent = state.title || '';
    title.title = state.title || '';

    const action = document.createElement('span');
    action.className = 'hidden-action';
    action.appendChild(icon('fa-eye'));
    action.appendChild(document.createTextNode(' Anzeigen'));

    meta.append(name, title, action);
    card.append(thumb, meta);
    card.addEventListener('click', () => {
      setHidden(user.id, false);
      if (!hiddenLiveUsers().length) closeHiddenPop();
    });

    els.hiddenList.appendChild(card);
  }
}

function openHiddenPop() {
  renderHiddenPop();
  els.hiddenPop.hidden = false;
  const anchor = els.hiddenBtn.getBoundingClientRect();
  const pop = els.hiddenPop.getBoundingClientRect();
  const left = anchor.left + anchor.width / 2 - pop.width / 2;
  els.hiddenPop.style.top = (anchor.bottom + 8) + 'px';
  els.hiddenPop.style.left = Math.max(8, Math.min(left, window.innerWidth - pop.width - 8)) + 'px';
}

function closeHiddenPop() {
  els.hiddenPop.hidden = true;
}

/* ================= Meldungen ================= */

let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4000);
}

/* ================= Bedienelemente ================= */

function openPanel() {
  els.panel.hidden = false;
  renderUserList();
  updateCheckInfo();
  els.userInput.focus();
}

function closePanel() {
  els.panel.hidden = true;
}

els.shows.addEventListener('click', () => (els.panel.hidden ? openPanel() : closePanel()));
els.panelClose.addEventListener('click', closePanel);
els.panel.addEventListener('mousedown', (e) => { if (e.target === els.panel) closePanel(); });

els.hiddenBtn.addEventListener('click', () => (els.hiddenPop.hidden ? openHiddenPop() : closeHiddenPop()));

els.userForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = addUsers(els.userInput.value, els.userHidden.checked);

  const parts = [];
  if (result.added.length === 1) parts.push(result.added[0].username + ' hinzugefügt');
  else if (result.added.length) parts.push(result.added.length + ' hinzugefügt');
  if (result.double.length === 1) parts.push(result.double[0] + ' war schon dabei');
  else if (result.double.length) parts.push(result.double.length + ' waren schon dabei');
  if (result.full) parts.push(result.full + ' nicht mehr aufgenommen (höchstens ' + MAX_USERS + ')');

  if (parts.length) toast(parts.join(' · '));
  else if (els.userInput.value.trim()) toast('Daraus konnte ich keinen Usernamen lesen');

  if (result.added.length) {
    els.userInput.value = '';
    els.userHidden.checked = false;
  }
  els.userInput.focus();
});

/* ---- Liste kopieren: gleiches Format wie die Eingabe ---- */

function userListText() {
  return users.map((user) => user.username).join(', ');
}

async function copyUserList() {
  const text = userListText();
  if (!text) { toast('Die Liste ist leer'); return; }
  let ok = false;
  // Ueber den Hauptprozess, weil die Zwischenablage im Browser an einen
  // sicheren Kontext gebunden ist - file:// ist keiner.
  if (window.wnms && window.wnms.copy) ok = await window.wnms.copy(text);
  if (!ok) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch (err) { ok = false; }
  }
  toast(ok
    ? users.length + ' Streamer kopiert – zum Weitergeben einfach einfügen'
    : 'Kopieren hat nicht geklappt');
}

els.copyBtn.addEventListener('click', copyUserList);

function requestCheck() {
  if (checkAll()) return;
  toast(users.length ? 'Prüfung läuft schon' : 'Erst Streamer hinzufügen');
}

els.checkNow.addEventListener('click', requestCheck);
els.check.addEventListener('click', requestCheck);

els.cols.addEventListener('change', () => {
  settings.cols = els.cols.value;
  els.optCols.value = settings.cols;   // derselbe Schalter steht auch in den Einstellungen
  saveSettings();
  layout();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 150);
});

els.muteAll.addEventListener('click', () => {
  unmutedBeforeFocus = null;
  setUnmuted(null);
});

els.reloadAll.addEventListener('click', () => {
  for (const tile of tiles.values()) {
    try { tile.webview.loadURL(tile.liveUrl); } catch (err) {}
  }
});

// Während des Ziehens laufen die Mausereignisse über das Overlay
els.dragOverlay.addEventListener('mousemove', (e) => moveRightPress({ x: e.clientX, y: e.clientY }));
els.dragOverlay.addEventListener('mouseup', (e) => endRightPress({ x: e.clientX, y: e.clientY }));
els.dragOverlay.addEventListener('contextmenu', (e) => e.preventDefault());

els.menu.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  const id = els.menu.dataset.id;
  if (!button || !id) return;
  const action = button.dataset.action;
  const tile = tiles.get(id);
  closeTileMenu();

  if (action === 'remove') removeUser(id);
  else if (action === 'hide') setHidden(id, true);
  else if (action === 'focus') setFocus(id);
  else if (!tile) return;
  else if (action === 'clean') applyView(tile, tile.gridView === 'video' ? 'full' : 'video');
  else if (action === 'chat') applyView(tile, tile.gridView === 'nochat' ? 'full' : 'nochat');
  else if (action === 'external') openInBrowser(tile.liveUrl);
  else if (action === 'reload') { try { tile.webview.loadURL(tile.liveUrl); } catch (err) {} }
  else if (action === 'ship') {
    // Von Hand setzen - noetig, wenn kein eigener Username hinterlegt ist
    if (shippingOf(id)) clearShipping(id);
    else markShipping(id, tile.lot ? tile.lot.shipping : '', true);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!els.menu.hidden && !els.menu.contains(e.target)) closeTileMenu();
  if (!els.hiddenPop.hidden && !els.hiddenPop.contains(e.target) && !els.hiddenBtn.contains(e.target)) closeHiddenPop();
  if (!els.lensPop.hidden && !els.lensPop.contains(e.target)) closeLensPop();
});

// Loslassen und Ziehen außerhalb der Kachelseiten (z. B. auf der Kopfzeile)
document.addEventListener('mousemove', (e) => {
  if (rightPress) moveRightPress({ x: e.clientX, y: e.clientY });
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 2 && rightPress) endRightPress({ x: e.clientX, y: e.clientY });
});

// Die Lupentaste auch dann auswerten, wenn die Tastatur beim App-Fenster liegt
// und nicht bei der Kachelseite - sonst haenge die Lupe davon ab, wo zuletzt
// geklickt wurde. Bei jedem Ereignis wird zugleich nachgezogen, ob die Taste
// ueberhaupt noch liegt; auf ein keyup allein ist kein Verlass.
function syncLensKey(event) {
  const down = event && event.getModifierState ? event.getModifierState(LENS_KEY) : false;
  if (down && focusedId) {
    lensKeyDown = true;
    if (!lens) openLens(focusedId, null);
  } else if (!down) {
    lensKeyDown = false;
    if (lens) closeLens();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === LENS_KEY) {
    e.preventDefault(); // Alt wuerde sonst den naechsten Tastendruck verschlucken
    lensKeyDown = true;
    if (focusedId) openLens(focusedId, null);
    return;
  }
  syncLensKey(e);
}, true);

document.addEventListener('keyup', (e) => {
  if (e.key === LENS_KEY) { closeLens(); return; }
  syncLensKey(e);
}, true);

document.addEventListener('mousemove', syncLensKey, true);
window.addEventListener('blur', closeLens);
document.addEventListener('visibilitychange', () => { if (document.hidden) closeLens(); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!els.menu.hidden) closeTileMenu();
  else if (!els.lensPop.hidden) closeLensPop();
  else if (!els.hiddenPop.hidden) closeHiddenPop();
  else if (!els.settingsPanel.hidden) closeSettings();
  else if (!els.panel.hidden) closePanel();
  else if (!els.setup.hidden) closeSetup();
  else if (focusedId) setFocus(null);
});

/* ================= Selbstaktualisierung =================
 *
 * Der Hauptprozess sieht bei GitHub nach und meldet hierher, was Sache ist.
 * Sichtbar wird davon nur etwas, wenn es auch etwas zu tun gibt: dann steht in
 * der Kopfleiste ein Knopf, der durch die drei Schritte fuehrt - laden,
 * Fortschritt, neu starten. Geladen wird nie von allein.
 */
let updateInfo = { state: 'idle' };

function renderUpdate() {
  const chip = els.updateBtn;
  const state = updateInfo.state;
  const show = state === 'available' || state === 'downloading' || state === 'ready';

  chip.hidden = !show;
  chip.classList.toggle('busy', state === 'downloading');
  chip.classList.toggle('ready', state === 'ready');
  if (!show) return;

  if (state === 'available') {
    chip.replaceChildren(icon('fa-arrow-rotate-up'), text('Version ' + updateInfo.version + ' laden'));
    chip.title = 'Neue Fassung verfügbar – herunterladen';
    chip.style.removeProperty('--done');
  } else if (state === 'downloading') {
    const percent = Math.max(0, Math.min(100, updateInfo.percent || 0));
    chip.replaceChildren(icon('fa-arrow-down'), text('lädt … ' + percent + ' %'));
    chip.title = 'Wird heruntergeladen';
    chip.style.setProperty('--done', percent + '%');
  } else {
    chip.replaceChildren(icon('fa-circle-check'), text('Neu starten für ' + updateInfo.version));
    chip.title = 'Fertig geladen – die App startet neu und spielt die Aktualisierung ein';
    chip.style.removeProperty('--done');
  }
}

function text(value) {
  return document.createTextNode(value);
}

function onUpdateState(state) {
  const before = updateInfo.state;
  updateInfo = state || { state: 'idle' };
  renderUpdate();
  renderAbout();
  if (updateInfo.state === 'available' && before !== 'available') {
    toast('Version ' + updateInfo.version + ' ist da – oben laden');
  }
  if (updateInfo.state === 'error' && updateInfo.asked) {
    toast('Aktualisierung: ' + updateInfo.message);
  }
}

/* Derselbe Zustand, nur ausfuehrlich: der Reiter "Updates & Über" sagt auch
 * dann etwas, wenn es nichts zu tun gibt ("du hast die neueste Fassung") -
 * der Knopf oben taucht dafuer gar nicht erst auf. */
function renderAbout() {
  if (!els.updateResult) return;
  const state = updateInfo.state;
  const version = updateInfo.version || '';

  const wording = {
    idle: 'Noch nicht nachgesehen. Die App sieht von sich aus alle drei Stunden nach.',
    checking: 'Sehe bei GitHub nach …',
    current: 'Alles aktuell – es gibt keine neuere Fassung.',
    available: 'Version ' + version + ' steht bereit.',
    downloading: 'Wird geladen … ' + (updateInfo.percent || 0) + ' %',
    ready: 'Version ' + version + ' ist geladen und wird beim Neustart eingespielt.',
    error: 'Nachsehen fehlgeschlagen: ' + (updateInfo.message || 'unbekannter Grund'),
    dev: 'Läuft aus dem Quelltext – hier gibt es nichts zu aktualisieren.'
  };
  els.updateResult.textContent = wording[state] || wording.idle;
  els.updateCheckBtn.disabled = state === 'checking' || state === 'downloading';

  const showAction = state === 'available' || state === 'ready';
  els.updateActionRow.hidden = !showAction;
  if (!showAction) return;

  if (state === 'available') {
    els.updateActionText.textContent = 'Herunterladen (rund 110 MB, läuft im Hintergrund).';
    els.updateActionBtn.replaceChildren(icon('fa-arrow-down'), text(' Version ' + version + ' laden'));
  } else {
    els.updateActionText.textContent = 'Die App startet dafür einmal neu.';
    els.updateActionBtn.replaceChildren(icon('fa-circle-check'), text(' Jetzt neu starten'));
  }
}

if (window.wnms && window.wnms.update) {
  window.wnms.update.onChange(onUpdateState);
  window.wnms.update.state().then(onUpdateState).catch(() => {});

  els.updateBtn.addEventListener('click', () => {
    if (updateInfo.state === 'available') window.wnms.update.download();
    else if (updateInfo.state === 'ready') window.wnms.update.install();
  });

  els.updateCheckBtn.addEventListener('click', () => window.wnms.update.check());
  els.updateActionBtn.addEventListener('click', () => {
    if (updateInfo.state === 'available') window.wnms.update.download();
    else if (updateInfo.state === 'ready') window.wnms.update.install();
  });
} else {
  els.updateCheckBtn.disabled = true;
}
/* ================= Eigene Titelleiste =================
 *
 * Der Systemrahmen ist weg (frame: false in main.js). Verschieben und der
 * Doppelklick zum Maximieren machen die Leiste selbst - dafuer traegt sie
 * -webkit-app-region: drag, alles Bedienbare darin traegt no-drag. Nur die drei
 * Knoepfe rechts brauchen den Hauptprozess.
 */
const winApi = (window.wnms && window.wnms.window) ? window.wnms.window : null;

function renderWindowState(state) {
  const maximized = Boolean(state && state.maximized);
  document.body.classList.toggle('is-maximized', maximized);
  els.winMax.title = maximized ? 'Wiederherstellen' : 'Maximieren';
  els.winMax.setAttribute('aria-label', els.winMax.title);
}

if (winApi) {
  els.winMin.addEventListener('click', () => winApi.minimize());
  els.winMax.addEventListener('click', () => winApi.toggleMaximize().then(renderWindowState).catch(() => {}));
  els.winClose.addEventListener('click', () => winApi.close());
  winApi.onChange(renderWindowState);
  winApi.state().then(renderWindowState).catch(() => {});
}

/* ================= Konto: Anmeldung, Name, Sperre =================
 *
 * Der eigene Whatnot-Name wird nicht mehr eingetippt. Er faellt an zwei Stellen
 * von allein an: beim Anmelden im eigenen Fenster und nebenbei bei jedem
 * Live-Abgleich (siehe readProfile). Beides laeuft ueber dieselbe Stelle im
 * Hauptprozess (account.js), die ihn merkt und gegen die Sperrliste haelt.
 */
const accountApi = (window.wnms && window.wnms.account) ? window.wnms.account : null;

let account = { username: '', loggedIn: false, banned: false };
let loginBusy = false;
let locked = false;
let lastReported = '';   // zuletzt gemeldeter Name, damit nicht jede Runde schreibt

function applyAccount(state) {
  account = Object.assign({ username: '', loggedIn: false, banned: false }, state || {});

  // Der erkannte Name ist zugleich der, an dem die Versand-Buendelung haengt.
  // Eingetippt werden muss er dafuer nicht mehr.
  if (account.username && !account.banned && settings.me !== account.username) {
    settings.me = account.username;
    saveSettings();
    for (const tile of tiles.values()) renderLot(tile);
    renderUserList();
  }
  if (els.meInput !== document.activeElement) els.meInput.value = settings.me || '';

  renderAccount();
  if (account.banned) lockDown();
  if (!els.setup.hidden) renderSetup();
}

function renderAccount() {
  const name = account.username || '';
  els.accName.textContent = name || 'Nicht angemeldet';
  els.accDot.classList.toggle('on', Boolean(name));
  els.accState.textContent = name
    ? 'Angemeldet – die Streams laufen mit diesem Konto.'
    : 'Ohne Anmeldung zeigt Whatnot nur ein Vorschaubild statt der Show.';
  els.accLoginLabel.textContent = loginBusy
    ? 'Anmeldefenster ist offen …'
    : (name ? 'Konto wechseln' : 'Anmelden');
  els.accLogin.disabled = loginBusy || locked;
  els.login.classList.toggle('on', Boolean(name));
  els.login.title = name ? 'Angemeldet als ' + name + ' – Konto wechseln' : 'Bei Whatnot anmelden';

  els.accAvatar.replaceChildren();
  const known = name ? users.find((user) => user.username.toLowerCase() === name.toLowerCase() && user.avatar) : null;
  if (known) {
    const img = document.createElement('img');
    img.src = known.avatar;
    img.alt = '';
    img.addEventListener('error', () => { img.remove(); els.accAvatar.appendChild(icon('fa-user')); });
    els.accAvatar.appendChild(img);
  } else {
    els.accAvatar.appendChild(icon(name ? 'fa-user-check' : 'fa-user'));
  }
}

// Nebenbei aufgeschnappter Name. Gemeldet wird nur, was neu ist - sonst
// schriebe jede Pruefrunde fuenfzehnmal dieselbe Zeile in die Ablage.
function reportAccount(name) {
  if (!accountApi || locked) return;
  const value = String(name || '').trim();
  if (!value || value.toLowerCase() === lastReported) return;
  lastReported = value.toLowerCase();
  accountApi.observe(value).then(applyAccount).catch(() => {});
}

// ... aber nicht fuer immer: alle zehn Minuten wird wieder hingesehen, damit
// eine inzwischen dazugekommene Sperre nicht bis zum Neustart wartet.
setInterval(() => { lastReported = ''; }, 10 * 60 * 1000);

function refreshAccount() {
  if (!accountApi) return Promise.resolve();
  return accountApi.state().then(applyAccount).catch(() => {});
}

function reloadEverything(message) {
  if (message) toast(message);
  for (const tile of tiles.values()) {
    try { tile.webview.loadURL(tile.liveUrl); } catch (err) { /* Kachel gerade weg */ }
  }
  // Auch der Pruefhelfer arbeitet mit den Cookies - der muss die neuen sehen
  try { els.checker.loadURL(CHECKER_HOME); } catch (err) {}
}

/* Der ganze Anmeldeweg an einer Stelle: Fenster auf, Erfolg abwarten, Konto
 * uebernehmen, Streams neu laden. Ein Abbruch loest bewusst nichts davon aus. */
async function doLogin() {
  if (locked) return null;
  if (!accountApi) { openInBrowser('https://www.whatnot.com/'); return null; }
  if (loginBusy) { toast('Das Anmeldefenster ist schon offen'); return null; }

  loginBusy = true;
  renderAccount();
  renderSetup();

  let info = null;
  try { info = await accountApi.login(); } catch (err) { info = null; }
  info = info || { result: 'cancelled' };

  loginBusy = false;
  await refreshAccount();

  if (info.result === 'ok') {
    lastReported = String(info.username || '').toLowerCase();
    if (info.reload) reloadEverything('Angemeldet als ' + info.username + ' – Streams werden neu geladen');
    else toast('Bereits angemeldet als ' + info.username);
  } else if (info.result === 'banned') {
    lockDown();
  } else if (info.result === 'cancelled') {
    toast('Anmeldung abgebrochen – es wurde nichts neu geladen');
  } else if (info.result === 'busy') {
    toast('Das Anmeldefenster ist schon offen');
  }

  renderAccount();
  renderSetup();
  return info;
}

/* Gesperrtes Konto. Die App wird stillgelegt: keine Kacheln, keine Pruefung,
 * kein Zugriff auf die Bedienung. Der Deckel liegt ueber allem und laesst sich
 * nicht wegklicken - und weil die Sperre in der Ablage steht, ist sie beim
 * naechsten Start sofort wieder da. */
function lockDown() {
  if (locked) return;
  locked = true;

  closeLens();
  closeLensPop();
  closeTileMenu();
  closeHiddenPop();
  closePanel();
  closeSettings();
  closeSetup(true);

  focusedId = null;
  clearInterval(checkTimer);
  for (const [id, tile] of tiles) {
    try { tile.webview.loadURL('about:blank'); } catch (err) {}
    tile.el.remove();
    tiles.delete(id);
  }
  try { els.checker.loadURL('about:blank'); } catch (err) {}

  els.lockedWho.textContent = account.username
    ? 'Betroffenes Konto: ' + account.username
    : '';
  els.locked.hidden = false;
}

els.lockedQuit.addEventListener('click', () => {
  if (winApi) winApi.close();
  else window.close();
});

els.login.addEventListener('click', () => doLogin());
els.accLogin.addEventListener('click', () => doLogin());

if (accountApi) {
  accountApi.onChange(applyAccount);
  refreshAccount();
}

/* ================= Einstellungen ================= */

const SETTINGS_TABS = ['general', 'account', 'about'];
let settingsTab = 'general';

function openSettings(tab) {
  if (locked) return;
  showSettingsTab(tab || settingsTab);
  renderSettings();
  els.settingsPanel.hidden = false;
}

function closeSettings() {
  els.settingsPanel.hidden = true;
}

function showSettingsTab(tab) {
  settingsTab = SETTINGS_TABS.indexOf(tab) >= 0 ? tab : 'general';
  for (const button of els.settingsTabs.querySelectorAll('[data-tab]')) {
    button.classList.toggle('on', button.dataset.tab === settingsTab);
  }
  for (const page of els.settingsPanel.querySelectorAll('[data-page]')) {
    page.hidden = page.dataset.page !== settingsTab;
  }
}

// Alle Schalter zeigen, was gerade gilt - egal ob es hier oder oben in der
// Leiste eingestellt wurde.
function renderSettings() {
  els.optStartCheck.checked = settings.startCheck !== false;
  els.optRestoreSound.checked = settings.restoreSound !== false;
  els.optCols.value = settings.cols;
  els.optView.value = VIEW_LOOK[settings.view] ? settings.view : 'full';
  els.optShowLot.checked = settings.showLot !== false;
  els.optShowTotal.checked = settings.showTotal !== false;
  els.lensKeyHint.textContent = LENS_KEY_LABEL;
  renderLensControls();
  renderAccount();
  renderAbout();
}

els.settingsBtn.addEventListener('click', () => (els.settingsPanel.hidden ? openSettings() : closeSettings()));
els.settingsClose.addEventListener('click', closeSettings);
els.settingsPanel.addEventListener('mousedown', (e) => { if (e.target === els.settingsPanel) closeSettings(); });

els.settingsTabs.addEventListener('click', (e) => {
  const button = e.target.closest('[data-tab]');
  if (button) showSettingsTab(button.dataset.tab);
});

els.optStartCheck.addEventListener('change', () => {
  settings.startCheck = els.optStartCheck.checked;
  saveSettings();
});

els.optRestoreSound.addEventListener('change', () => {
  settings.restoreSound = els.optRestoreSound.checked;
  saveSettings();
});

els.optCols.addEventListener('change', () => {
  settings.cols = els.optCols.value;
  els.cols.value = settings.cols;
  saveSettings();
  layout();
});

els.optView.addEventListener('change', () => applyViewAll(els.optView.value));

els.optShowLot.addEventListener('change', () => {
  settings.showLot = els.optShowLot.checked;
  saveSettings();
  for (const tile of tiles.values()) renderLot(tile);
});

els.optShowTotal.addEventListener('change', () => {
  settings.showTotal = els.optShowTotal.checked;
  saveSettings();
  for (const tile of tiles.values()) renderLot(tile);
});

els.optLensSize.addEventListener('input', () => setLensSize(els.optLensSize.value));
els.optLensMag.addEventListener('input', () => setLensMag(els.optLensMag.value));
els.lensPopSize.addEventListener('input', () => setLensSize(els.lensPopSize.value));
els.lensPopMag.addEventListener('input', () => setLensMag(els.lensPopMag.value));
els.lensPop.addEventListener('mousedown', (e) => e.stopPropagation());

els.optSetupAgain.addEventListener('click', () => {
  closeSettings();
  restartSetup();
});

els.repoBtn.addEventListener('click', () => openInBrowser(appInfo.repo || REPO_FALLBACK));

/* ================= Einrichtung beim ersten Start =================
 *
 * Fuehrt der Reihe nach durch das, was einmal getan werden muss: anmelden,
 * Streamer eintragen, das Wichtigste zur Bedienung. Der Fortschritt steht in
 * der Ablage - wer abbricht, macht beim naechsten Start an derselben Stelle
 * weiter, und wer durch ist, sieht den Assistenten nie wieder (ausser er ruft
 * ihn in den Einstellungen selbst wieder auf).
 */
const SETUP_KEY = 'wnms.setup.v1';
const SETUP_LAST = 5;

let setupState = Object.assign({ done: false, step: 1 }, load(SETUP_KEY, null) || {});

// Wer die App schon benutzt hat, hat die Einrichtung laengst hinter sich - dem
// soll der Assistent nach einer Aktualisierung nicht ploetzlich vor der Nase
// stehen. Erkennbar ist das an der vorhandenen Streamerliste.
if (load(SETUP_KEY, null) === null && users.length) {
  setupState = { done: true, step: SETUP_LAST };
  store(SETUP_KEY, setupState);
}

function saveSetup() {
  store(SETUP_KEY, setupState);
}

function setupStep(step) {
  setupState.step = Math.min(SETUP_LAST, Math.max(1, Number(step) || 1));
  saveSetup();
  renderSetup();
}

function openSetup() {
  if (locked) return;
  closePanel();
  closeSettings();
  els.setup.hidden = false;
  renderSetup();
}

function closeSetup(silent) {
  if (els.setup.hidden) return;
  els.setup.hidden = true;
  // Abgebrochen heisst: nicht fertig. Beim naechsten Start geht es hier weiter.
  if (!silent && !setupState.done && !users.length) openPanel();
}

function finishSetup() {
  setupState.done = true;
  setupState.step = SETUP_LAST;
  saveSetup();
  closeSetup(true);
  toast('Einrichtung abgeschlossen – viel Erfolg beim Schnappen');
}

function restartSetup() {
  setupState = { done: false, step: 1 };
  saveSetup();
  openSetup();
}

function renderSetup() {
  if (els.setup.hidden) return;
  const step = setupState.step;

  for (const page of els.setup.querySelectorAll('.setup-page')) {
    page.hidden = Number(page.dataset.step) !== step;
  }

  // Punktleiste oben
  els.setupSteps.replaceChildren();
  for (let i = 1; i <= SETUP_LAST; i++) {
    const dot = document.createElement('span');
    dot.className = 'setup-dot' + (i === step ? ' on' : '') + (i < step ? ' done' : '');
    els.setupSteps.appendChild(dot);
  }

  els.setupBack.hidden = step <= 1;
  els.setupSkip.hidden = step >= SETUP_LAST;

  if (step === 2) {
    els.setupLogin.disabled = loginBusy;
    els.setupLoginState.textContent = loginBusy
      ? 'Das Anmeldefenster ist offen – melde dich dort an.'
      : (account.username ? 'Angemeldet als ' + account.username + '.' : '');
    els.setupNext.replaceChildren(text(account.username ? 'Weiter ' : 'Ohne Anmeldung weiter '), icon('fa-arrow-right'));
  } else if (step === 3) {
    els.setupWho.textContent = account.username || 'unbekannt';
    els.setupNext.replaceChildren(text('Weiter '), icon('fa-arrow-right'));
  } else if (step === 4) {
    renderSetupList();
    els.setupNext.replaceChildren(text(users.length ? 'Weiter ' : 'Später eintragen '), icon('fa-arrow-right'));
  } else if (step === SETUP_LAST) {
    els.setupNext.replaceChildren(icon('fa-check'), text(' Fertig'));
  } else {
    els.setupNext.replaceChildren(text('Weiter '), icon('fa-arrow-right'));
  }
}

function renderSetupList() {
  els.setupList.replaceChildren();
  if (!users.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Noch niemand eingetragen. Du kannst das auch später unter „Shows“ nachholen.';
    els.setupList.appendChild(hint);
    return;
  }
  for (const user of users) {
    const chip = document.createElement('span');
    chip.className = 'setup-chip';
    chip.append(avatarFor(user), document.createTextNode(user.username));
    const kill = document.createElement('button');
    kill.type = 'button';
    kill.title = 'Wieder entfernen';
    kill.appendChild(icon('fa-xmark'));
    kill.addEventListener('click', () => { removeUser(user.id); renderSetupList(); renderSetup(); });
    chip.appendChild(kill);
    els.setupList.appendChild(chip);
  }
}

els.setupNext.addEventListener('click', async () => {
  const step = setupState.step;
  if (step === SETUP_LAST) { finishSetup(); return; }

  // Schritt 2 fuehrt nur dann zur Bestaetigung, wenn wirklich jemand angemeldet ist
  if (step === 2 && !account.username) { setupStep(4); return; }
  setupStep(step + 1);
});

els.setupBack.addEventListener('click', () => {
  const step = setupState.step;
  // Schritt 3 gibt es ohne Anmeldung nicht - von 4 aus also gleich zurueck zu 2
  if (step === 4 && !account.username) { setupStep(2); return; }
  setupStep(step - 1);
});

els.setupSkip.addEventListener('click', () => {
  // Ueberspringen heisst: fuer diesmal genug, nicht erledigt
  closeSetup();
});

els.setupLogin.addEventListener('click', async () => {
  const info = await doLogin();
  // Nach erfolgreicher Anmeldung von selbst zur Bestaetigung weiterziehen
  if (info && info.result === 'ok' && setupState.step === 2) setupStep(3);
});

els.setupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = addUsers(els.setupInput.value, false);
  if (result.added.length) els.setupInput.value = '';
  else if (result.double.length) toast(result.double.length + ' waren schon dabei');
  else if (els.setupInput.value.trim()) toast('Daraus konnte ich keinen Usernamen lesen');
  renderSetupList();
  renderSetup();
  els.setupInput.focus();
});

/* ================= Start ================= */

const REPO_FALLBACK = 'https://github.com/zqqqqx/whatnot-multistream';
let appInfo = { version: '', repo: REPO_FALLBACK, packaged: false };

if (window.wnms && window.wnms.info) {
  window.wnms.info().then((info) => {
    appInfo = Object.assign(appInfo, info || {});
    els.aboutVersion.textContent = 'Version ' + (appInfo.version || '?')
      + (appInfo.packaged ? '' : ' · aus dem Quelltext');
    els.aboutHint.textContent = appInfo.packaged
      ? 'Aktualisierungen kommen aus dem Release-Bereich des Projekts. Geladen wird nur auf Klick.'
      : 'Im Quelltextbetrieb ist die Selbstaktualisierung abgeschaltet.';
    renderAbout();
  }).catch(() => {});
}

els.cols.value = settings.cols;
renderViewAll();
renderLensControls();
els.lensPopKey.textContent = LENS_KEY_LABEL;
els.meInput.value = settings.me || '';
renderAccount();

els.viewAll.addEventListener('click', () => applyViewAll(nextView(settings.view)));

// Eigener Username: wird beim Anmelden erkannt, laesst sich hier aber weiter
// von Hand setzen - etwa wenn jemand die App ohne Anmeldung benutzt.
let meStateTimer = null;

function saveMe() {
  const value = els.meInput.value.trim().replace(/^@/, '');
  if (value === (settings.me || '')) { flashMeState(value ? 'gespeichert' : 'leer – aus'); return; }
  settings.me = value;
  els.meInput.value = value;
  saveSettings();
  for (const tile of tiles.values()) renderLot(tile);
  flashMeState(value ? 'gespeichert' : 'leer – aus');
}

function flashMeState(message) {
  els.meState.textContent = message;
  els.meState.classList.add('on');
  clearTimeout(meStateTimer);
  meStateTimer = setTimeout(() => els.meState.classList.remove('on'), 2200);
}

els.meSave.addEventListener('click', saveMe);
els.meInput.addEventListener('blur', saveMe);
els.meInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  saveMe();
});

syncTiles();
renderUserList();
updateCheckInfo();

// Erste Runde, sobald der Helfer steht
whenCheckerReady().then(() => {
  if (locked) return;
  if (settings.startCheck !== false) checkAll();
});

// Beim allerersten Start fuehrt der Assistent durch alles Noetige. Wer ihn
// abgebrochen hat, landet wieder an der Stelle, an der er aufgehoert hat.
if (!setupState.done) openSetup();
else if (!users.length) openPanel();
