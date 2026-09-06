// Läuft in jeder Stream-Kachel.
//
// Warum: contents.setZoomFactor() teilt den Zoom in Electron zwischen allen Seiten
// derselben Herkunft in einer Session – alle Kacheln sind whatnot.com, also würde
// die zuletzt gesetzte Stufe für alle gelten. webFrame.setZoomFactor() wirkt dagegen
// nur auf diesen einen Frame, so kann die fokussierte Kachel in Originalgröße laufen,
// während die anderen verkleinert bleiben.
const { webFrame, ipcRenderer } = require('electron');

ipcRenderer.on('wnms-zoom', (_event, factor, seq) => {
  try {
    webFrame.setZoomFactor(factor);
  } catch (err) { /* Frame noch nicht bereit */ }
  // Die laufende Nummer kommt in der Fertigmeldung zurueck - so kann die App
  // eine verspaetete Meldung von vorhin nicht mit der aktuellen verwechseln.
  settleSeq = seq || 0;
  watchSettled();
});

// Beim Wechsel zwischen Vorschau und großem Modus hält die App einen Deckel
// über die Kachel, bis die Seite ihr Layout neu aufgebaut hat. Wann das ist,
// weiß nur die Seite selbst – und ein fester Zeitwert trifft es nie: Whatnot
// wechselt zwischen Handy- und Desktop-Ansicht, lädt dabei andere Bilder nach
// und hängt das Video neu ein. Deshalb wird auf zwei Dinge zugleich gewartet:
//
//   1. das Layout bewegt sich nicht mehr (gleiche Maße über mehrere Proben)
//   2. das Video läuft wieder (genug Daten gepuffert, nicht pausiert)
//
// Erst dann kommt die Entwarnung. Bleibt sie aus, weil das Video z. B. auf
// einen Klick wartet, greift die Frist unten.
const SETTLE_POLL_MS = 90;
const SETTLE_STABLE = 2;     // so viele gleiche Proben = Layout steht
const SETTLE_LIMIT_MS = 5000;

let settleTimer = null;
let settleSeq = 0;
let settleSignature = '';
let settleStable = 0;
let settleUntil = 0;

// Das gemeinte Video ist das größte auf der Seite - Whatnot zeigt daneben
// kleine Vorschauen anderer Shows.
function mainVideo() {
  let best = null;
  let bestArea = 0;
  for (const video of document.querySelectorAll('video')) {
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) { bestArea = area; best = video; }
  }
  return best;
}

function layoutSignature(video) {
  const rect = video ? video.getBoundingClientRect() : null;
  return [
    window.innerWidth,
    window.innerHeight,
    document.body ? Math.round(document.body.scrollHeight) : 0,
    rect ? Math.round(rect.width) : -1,
    rect ? Math.round(rect.height) : -1,
    rect ? Math.round(rect.top) : -1
  ].join(':');
}

function pollSettled() {
  const video = mainVideo();
  const signature = layoutSignature(video);
  if (signature === settleSignature) settleStable++;
  else { settleSignature = signature; settleStable = 0; }

  // readyState 3 = HAVE_FUTURE_DATA, es ist also wieder ein Bild da
  const playing = Boolean(video) && video.readyState >= 3 && !video.paused;
  // Ohne Anmeldung liegt ein Fenster ueber dem Stream, manchmal wartet das
  // Video auch auf einen Klick - dann zaehlt allein, dass sich nichts mehr regt.
  const veryStable = settleStable >= SETTLE_STABLE * 4;
  const ready = settleStable >= SETTLE_STABLE && (playing || veryStable);
  if (!ready && Date.now() < settleUntil) return;

  clearInterval(settleTimer);
  settleTimer = null;
  // zwei Bilder abwarten, damit das Gemeldete auch wirklich gezeichnet ist
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { ipcRenderer.sendToHost('wnms-zoomed', { ready: ready, seq: settleSeq }); } catch (err) {}
  }));
}

function watchSettled() {
  settleSignature = '';
  settleStable = 0;
  settleUntil = Date.now() + SETTLE_LIMIT_MS;
  if (settleTimer) return;
  settleTimer = setInterval(pollSettled, SETTLE_POLL_MS);
}

window.addEventListener('resize', watchSettled);

/* ================= Rechte Maustaste weiterreichen =================
 *
 * Die Kachel verschluckt sonst alle Mausereignisse: die rechte Maustaste wird
 * deshalb an die App weitergereicht (Rechtsklick = Menue, Rechtsklick + Ziehen =
 * Kachel umsortieren). In der Capture-Phase, damit Whatnots eigene Handler
 * nichts abfangen koennen.
 */
let rightDown = false;
let lastPoint = { x: 0, y: 0 };

window.addEventListener('mousedown', (event) => {
  if (event.button !== 2) return;
  rightDown = true;
  ipcRenderer.sendToHost('wnms-rdown', { x: event.clientX, y: event.clientY });
}, true);

window.addEventListener('mousemove', (event) => {
  lastPoint = { x: event.clientX, y: event.clientY };
  if (!rightDown) return;
  ipcRenderer.sendToHost('wnms-rmove', lastPoint);
}, true);

window.addEventListener('mouseup', (event) => {
  if (event.button !== 2 || !rightDown) return;
  rightDown = false;
  ipcRenderer.sendToHost('wnms-rup', { x: event.clientX, y: event.clientY });
}, true);

// Whatnots eigenes Kontextmenü unterdrücken – die App zeigt ihr eigenes
window.addEventListener('contextmenu', (event) => event.preventDefault(), true);

/* ================= Los-Leser =================
 *
 * Die Show-Oberflaeche von Whatnot hat benannte Haltepunkte, an denen sich der
 * Zustand der laufenden Auktion ablesen laesst:
 *
 *   show-product-title   "Amazon A.B Ware #77"
 *   show-timer           "00:02"                  (Restzeit mm:ss)
 *   show-bid-button      "Gebot: 8 €"             (was das naechste Gebot kostet)
 *   show-winning-status  "amjiamj erhaelt den Zuschlag!"  bzw. "... hat gewonnen!"
 *   show-winner-message  "djbigbaer hat die Auktion gewonnen!"  (nur beim Hammer)
 *   show-shipping-info   "Der Versand betraegt 6,05 € + Steuern"
 *
 * Gelesen wird in der Kachel selbst, gemeldet wird nur bei Aenderung und nur ein
 * winziges Objekt - die Seite selbst ist gut zwei Megabyte gross.
 */
const LOT_POLL_MS = 700;

function testidText(id) {
  const el = document.querySelector('[data-testid="' + id + '"]');
  if (!el) return '';
  return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

// "00:42" -> 42, "1:05" -> 65
function parseClock(text) {
  const hit = /(\d{1,2}):(\d{2})/.exec(text || '');
  if (!hit) return null;
  return Number(hit[1]) * 60 + Number(hit[2]);
}

// "8,50" -> 8.5 | "1.234,56" -> 1234.56 | "1,234.56" -> 1234.56 | "12" -> 12
// Welches Zeichen trennt die Nachkommastellen, verraet die Stellung: das
// *letzte* Trennzeichen mit genau zwei Ziffern dahinter ist das Komma.
function parseAmount(raw) {
  let text = String(raw || '').replace(/\s/g, '');
  if (!/\d/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  const cut = Math.max(lastComma, lastDot);
  if (cut >= 0 && /^\d{1,2}$/.test(text.slice(cut + 1))) {
    text = text.slice(0, cut).replace(/[.,]/g, '') + '.' + text.slice(cut + 1);
  } else {
    text = text.replace(/[.,]/g, '');
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

// "Gebot: 8 €" -> { text: "8 €", value: 8, currency: "€" }
// "Der Versand betraegt 6,05 € + Steuern" -> { text: "6,05 €", value: 6.05, ... }
function parseMoney(text) {
  const hit = /(\d[\d.,]*)\s*(€|\$|£|EUR|USD|GBP)|(€|\$|£)\s*(\d[\d.,]*)/.exec(text || '');
  if (!hit) return { text: '', value: null, currency: '' };
  const digits = hit[1] || hit[4];
  const currency = (hit[2] || hit[3] || '').replace(/EUR/i, '€').replace(/USD/i, '$').replace(/GBP/i, '£');
  return {
    text: hit[1] ? hit[1] + ' ' + (hit[2] || '') : (hit[3] || '') + hit[4],
    value: parseAmount(digits),
    currency: currency
  };
}

// "amjiamj erhaelt den Zuschlag!" -> { wer: "amjiamj", zuschlag: false }
// "blackmushu hat gewonnen!"      -> { wer: "blackmushu", zuschlag: true }
function parseStatus(text) {
  const t = (text || '').trim();
  if (!t) return { wer: '', zuschlag: false };
  const name = (/^@?([A-Za-z0-9_.-]{2,40})\b/.exec(t) || [])[1] || '';
  return { wer: name, zuschlag: /gewonnen|won|sold to/i.test(t) };
}

function readLot() {
  if (!/\/live\//.test(location.pathname)) return null;
  const title = testidText('show-product-title');
  const timer = testidText('show-timer');
  const bidText = testidText('show-bid-button');
  const statusText = testidText('show-winning-status');
  const winnerText = testidText('show-winner-message'); // erscheint erst beim Hammer
  const shippingText = testidText('show-shipping-info');
  if (!title && !bidText && !timer) return null; // Auktionsteil noch nicht da

  // Der Hammer wird doppelt gemeldet: als Zustand ("... hat gewonnen!") und als
  // eigene Zeile ("... hat die Auktion gewonnen!"). Die eigene Zeile ist
  // eindeutiger, deshalb hat sie Vorrang.
  const status = parseStatus(statusText);
  const winner = parseStatus(winnerText);
  const done = winner.zuschlag || status.zuschlag;
  const bid = parseMoney(bidText);
  const shipping = parseMoney(shippingText);

  return {
    title: title,
    rest: parseClock(timer),          // Sekunden bis zum Hammer, null = kein Countdown
    bid: bid.text,                    // was das naechste Gebot kostet
    bidValue: bid.value,              // dasselbe als Zahl, fuer die Summe mit Versand
    currency: bid.currency || shipping.currency,
    leader: (done && winner.wer) || status.wer || winner.wer,
    done: done,
    shipping: shipping.text,          // Versandkosten dieses Verkaeufers
    shippingValue: shipping.value,
    statusText: (winnerText || statusText).slice(0, 90),
    maxLimit: maxLimit,               // eigene Grenze fuer dieses Los, null = keine
    maxCeiling: maxCeiling(),         // Grenze zuzueglich Spielraum
    maxBlocked: maxBlocked            // Grenze ueberschritten, Gebots-Knopf ist weg
  };
}

let lastLot = '';

function pollLot() {
  let lot = null;
  try { lot = readLot(); } catch (err) { lot = null; }
  const signature = lot
    ? [lot.title, lot.rest, lot.bid, lot.leader, lot.done, lot.shipping, lot.maxLimit, lot.maxBlocked].join('|')
    : '';
  if (signature === lastLot) return;
  lastLot = signature;
  try { ipcRenderer.sendToHost('wnms-lot', lot); } catch (err) {}
}

/* ================= Kopfzeile der Show ausduennen =================
 *
 * Ueber dem Videobild liegt Whatnots eigene Kopfzeile: Profilbild, Name des
 * Streamers, Bewertung, "Folgen" und die Zuschauerzahl. Genau das steht in der
 * Kachelleiste der App schon - zweimal dasselbe kostet nur Bild.
 *
 * Ausgeblendet wird mit visibility statt display: Die Kopfzeile ist eine eigene
 * Zeile im Raster des Players ("header"), und die faellt bei display:none in
 * sich zusammen - alles darunter, bis hin zum Gebots-Knopf, ruckte um ihre Hoehe
 * nach oben. So bleibt die Aufteilung, wie sie ist, und nur der Inhalt ist weg.
 *
 * Getroffen wird ueber den bestaendigen Teil des Klassennamens: Whatnot haengt
 * seinen CSS-Bausteinen bei jedem Bau eine neue Endung an
 * (LivePlayer_livePlayerHeader__vENUi), der Rumpf bleibt.
 */
const TRIM_CSS = [
  'header[class*="livePlayerHeader"] {',
  '  visibility: hidden !important;',
  '  pointer-events: none !important;',
  '}',
  // Grenze erreicht: der Gebots-Knopf verschwindet. Als Regel statt als
  // Eigenschaft am Knopf, denn den baut Whatnot staendig neu - eine Klasse am
  // <html> ueberlebt das, ein style-Attribut am Knopf nicht.
  'html.wnms-bid-off [data-testid="show-bid-button"] { display: none !important; }'
].join('\n');

function trimUi() {
  if (document.getElementById('wnms-trim')) return;
  const head = document.head || document.documentElement;
  if (!head) return;
  const style = document.createElement('style');
  style.id = 'wnms-trim';
  style.textContent = TRIM_CSS;
  head.appendChild(style);
}

trimUi();
document.addEventListener('DOMContentLoaded', trimUi, { once: true });

/* ================= Laeuft die Show ueberhaupt noch? =================
 *
 * Endet eine Show, merkte die App das bisher erst bei der naechsten regulaeren
 * Runde - die Kachel stand dann noch ein bis zwei Minuten mit einem stehenden
 * Bild herum.
 *
 * Die Kachel selbst sieht es viel frueher, denn sie hat drei Anzeichen:
 *
 *   1. die Adresse ist keine Show-Adresse mehr (Whatnot leitet weiter)
 *   2. der Player ist gar nicht mehr da
 *   3. das Bild steht: die Laufzeit des Videos ruehrt sich nicht mehr
 *
 * Entschieden wird hier aber nichts. Gemeldet wird nur ein Verdacht; ob der
 * Streamer wirklich aufgehoert hat, holt die App danach von der Profilseite -
 * der einzigen Stelle, die es sicher weiss. Ein Fehlalarm kostet damit eine
 * zusaetzliche Abfrage und sonst nichts.
 */
const LIVE_POLL_MS = 3000;
const LIVE_STALL_MS = 15000;   // so lange darf das Bild stehen, ehe nachgefragt wird

const LIVE_REPEAT_MS = 30000;  // steht es weiter, wird der Verdacht erneuert

let liveLastTime = -1;
let liveMovedAt = Date.now();
let liveLastPoll = Date.now();
let liveSaid = null;           // was zuletzt gemeldet wurde
let liveSaidAt = 0;

function pollLive() {
  const now = Date.now();
  const gap = now - liveLastPoll;
  liveLastPoll = now;

  // Wird das Fenster nicht gezeichnet (verdeckt, minimiert), drosselt Chromium
  // sowohl das Video als auch diesen Takt. Ein langer Sprung zwischen zwei
  // Proben sagt darum nichts aus - die Uhr faengt einfach von vorn an.
  if (document.hidden || gap > LIVE_POLL_MS * 3) {
    liveMovedAt = now;
    return;
  }

  const onShow = /\/live\//.test(location.pathname);
  const player = document.querySelector('section[class*="LivePlayer_livePlayer__"]');
  const video = mainVideo();
  const time = video ? video.currentTime : -1;

  if (video && time !== liveLastTime) {
    liveLastTime = time;
    liveMovedAt = now;
  }

  let reason = '';
  if (!onShow) reason = 'nicht mehr auf der Show-Seite';
  else if (!player) reason = 'der Player ist verschwunden';
  else if (now - liveMovedAt > LIVE_STALL_MS) reason = 'das Bild steht seit ' + Math.round((now - liveMovedAt) / 1000) + ' s';

  const alive = !reason;
  // Beim Wechsel melden - und solange es steht, in Abstaenden noch einmal:
  // Sagt die Profilseite beim ersten Mal noch "laeuft", soll die App es
  // wenig spaeter wieder versuchen statt bis zur naechsten Runde zu warten.
  const wiederholen = !alive && now - liveSaidAt > LIVE_REPEAT_MS;
  if (alive === liveSaid && !wiederholen) return;
  liveSaid = alive;
  liveSaidAt = now;
  try { ipcRenderer.sendToHost('wnms-live', { alive: alive, reason: reason }); } catch (err) {}
}

/* ================= Beitritts-Meldung ausblenden =================
 *
 * Beim Betreten einer Show wirft Whatnot eine Einblendung hoch ("Du nimmst
 * jetzt an ... Stream teil"). Bei einer Wand aus Kacheln erscheint die reihum
 * in jeder einzelnen und verdeckt jedes Mal ein Stueck Bild.
 *
 * Ausgeblendet wird deshalb *nur* diese eine Meldung, erkannt am Wortlaut -
 * nicht etwa alles, was wie eine Einblendung aussieht. Fehlermeldungen,
 * Gebotshinweise und der uebrige Kram bleiben also stehen. Vom Treffer aus geht
 * es so weit nach oben, wie der Zweig nichts anderes als diesen Text enthaelt;
 * damit verschwindet die Einblendung samt Rahmen, aber nichts darueber hinaus.
 */
const JOIN_PATTERNS = [
  /du\s+nimmst\s+(?:jetzt\s+)?an\b[\s\S]{0,90}\bteil/i,
  /nimmst\s+du\s+(?:jetzt\s+)?an\b[\s\S]{0,90}\bteil/i,
  /du\s+bist\s+(?:jetzt\s+)?(?:dem|der|den)?\s*[\s\S]{0,60}\bbeigetreten/i,
  /you(?:'re|’re|\s+are)\s+now\s+(?:in|watching|participating|attending)\b/i,
  /you(?:'ve|’ve|\s+have)?\s*joined\b[\s\S]{0,60}\b(?:stream|show|livestream)/i
];

const JOIN_MAX_TEXT = 200; // Einblendungen sind kurz; alles Laengere ist etwas anderes
const JOIN_MAX_UP = 5;     // so weit hoechstens nach oben gehen

function looksLikeJoin(text) {
  if (!text || text.length > JOIN_MAX_TEXT) return false;
  return JOIN_PATTERNS.some((rule) => rule.test(text));
}

function joinBox(el) {
  // Vom Textknoten aus nach oben, solange der Zweig nichts als diesen Text
  // enthaelt - das ist die Einblendung mitsamt ihrem Rahmen.
  const own = (el.textContent || '').trim();
  let node = el;
  for (let i = 0; i < JOIN_MAX_UP; i++) {
    const parent = node.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    if (parent.querySelector('video')) break;                       // nie das Videoteil
    if ((parent.textContent || '').trim() !== own) break;            // haette Geschwister
    node = parent;
  }
  return node;
}

function hideJoin(el) {
  try {
    const box = joinBox(el);
    if (box.dataset && box.dataset.wnmsJoinHidden) return;
    if (box.dataset) box.dataset.wnmsJoinHidden = '1';
    box.style.setProperty('display', 'none', 'important');
  } catch (err) { /* Knoten schon wieder weg */ }
}

function scanJoin(root) {
  if (!root || root.nodeType !== 1) return;
  try {
    if (looksLikeJoin((root.innerText || root.textContent || '').trim())) { hideJoin(root); return; }
    // Nur in kleine Zweige hineinsehen - der Rest der Seite ist zu gross dafuer
    const text = (root.textContent || '');
    if (!text || text.length > JOIN_MAX_TEXT * 6) return;
    for (const child of root.querySelectorAll('*')) {
      if (looksLikeJoin((child.textContent || '').trim())) { hideJoin(child); return; }
    }
  } catch (err) { /* Baum aendert sich gerade */ }
}

let joinObserver = null;

function watchJoin() {
  if (joinObserver || !document.body) return;
  joinObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scanJoin(node);
    }
  });
  joinObserver.observe(document.body, { childList: true, subtree: true });
}

// Nachzuegler: Einblendungen mit eigener Rolle werden ohnehin gemeldet, aber
// eine, die schon vor dem Beobachter dastand, faende er nie.
function sweepJoin() {
  for (const el of document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')) {
    if (looksLikeJoin((el.textContent || '').trim())) hideJoin(el);
  }
}

if (document.body) watchJoin();
else document.addEventListener('DOMContentLoaded', watchJoin, { once: true });

/* ================= Nur den Chat ausblenden =================
 *
 * "Nur Video" blendet die ganze Oberflaeche aus. Oft will man aber nur den
 * Chat los und Shop, Preis und Gebots-Schaltflaechen behalten.
 *
 * Der Chat sitzt je nach Layout woanders: im Desktop-Layout in
 * [data-testid="desktop-chat-panel"], im Handy-Layout gibt es den gar nicht,
 * dort stehen nur die Liste (virtuoso-scroller) und das Eingabefeld
 * (chat-input) untereinander. Statt Klassennamen zu raten wird deshalb von der
 * Chatliste aus so weit nach oben gegangen, wie der Zweig noch *kein* Video
 * enthaelt - das ist genau die Chatspalte und sonst nichts.
 *
 * Whatnot baut seine Oberflaeche staendig neu auf, deshalb wird die Regel im
 * Takt des Los-Lesers nachgezogen.
 */
let chatHidden = false;
let chatNode = null;
let chatPrevDisplay = '';

function chatRoot() {
  const anchor = document.querySelector('[data-testid="desktop-chat-panel"]')
    || document.querySelector('[data-testid="virtuoso-scroller"]')
    || document.querySelector('[data-testid="chat-input"]');
  if (!anchor) return null;
  let node = anchor;
  while (node.parentElement
    && node.parentElement !== document.body
    && node.parentElement !== document.documentElement
    && !node.parentElement.querySelector('video')) {
    node = node.parentElement;
  }
  return node;
}

function restoreChat() {
  if (!chatNode) return;
  try { chatNode.style.display = chatPrevDisplay; } catch (err) {}
  chatNode = null;
  chatPrevDisplay = '';
}

function applyChat() {
  if (!chatHidden) { restoreChat(); return; }
  const root = chatRoot();
  if (!root || root === chatNode) return;
  restoreChat();
  chatNode = root;
  chatPrevDisplay = root.style.display;
  root.style.display = 'none';
}

ipcRenderer.on('wnms-chat', (_event, on) => {
  chatHidden = Boolean(on);
  applyChat();
});

/* ================= Max-Gebot =================
 *
 * Neben Whatnots gelbem Gebots-Knopf steht ein zweiter: "Max". Dort traegt man
 * ein, bis wohin man bei *diesem* Los mitgehen will. Ist das naechste Gebot
 * darueber (zuzueglich des Spielraums aus den Einstellungen), verschwindet der
 * gelbe Knopf - versehentlich ueber die eigene Grenze klicken geht dann nicht
 * mehr. Mit dem naechsten Los faengt alles wieder von vorn an.
 *
 * Geboten wird hier nie von selbst: Dieser Teil liest und blendet aus, er
 * betaetigt Whatnots Knoepfe unter keinen Umstaenden.
 */
const MAX_BTN_ID = 'wnms-max-btn';
const MAX_NOTE_ID = 'wnms-max-note';
const MAX_POP_ID = 'wnms-max-pop';

let maxCfg = { on: true, plus: 0 };
let maxLimit = null;      // Grenze fuer das laufende Los, null = keine gesetzt
let maxLot = '';          // zu welchem Los sie gehoert
let maxBlocked = false;   // Grenze ueberschritten, Gebots-Knopf ist weg
let maxCurrency = '';
let maxFehlt = 0;         // so viele Takte in Folge ohne Gebots-Knopf

const MAX_GONE_TICKS = 4; // erst danach gilt die Auktion als vorbei

function bidButton() {
  return document.querySelector('[data-testid="show-bid-button"]');
}

function money(value) {
  const text = Number(value).toFixed(2).replace(/[.,]00$/, '').replace('.', ',');
  return maxCurrency ? text + ' ' + maxCurrency : text;
}

// Deckel, bis zu dem geboten werden darf
function maxCeiling() {
  if (maxLimit === null) return null;
  const plus = Number(maxCfg.plus) || 0;
  return maxLimit + (plus > 0 ? plus : 0);
}

function styleButton(el, look) {
  const base = 'height:44px;padding:0 16px;border:none;border-radius:999px;cursor:pointer;'
    + 'font-family:inherit;font-size:14px;font-weight:600;line-height:1;'
    + 'display:inline-flex;align-items:center;justify-content:center;gap:6px;'
    + 'flex:0 0 auto;white-space:nowrap;';
  el.setAttribute('style', base + look);
}

function removeById(id) {
  const el = document.getElementById(id);
  if (el && el.parentElement) el.parentElement.removeChild(el);
}

function closeMaxPop() {
  removeById(MAX_POP_ID);
}

function openMaxPop() {
  closeMaxPop();
  const bid = bidButton();
  if (!bid) return;

  const box = document.createElement('div');
  box.id = MAX_POP_ID;
  const rect = bid.getBoundingClientRect();
  const width = 238;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  box.setAttribute('style', 'position:fixed;z-index:2147483646;width:' + width + 'px;'
    + 'left:' + Math.round(left) + 'px;bottom:' + Math.round(window.innerHeight - rect.top + 10) + 'px;'
    + 'padding:12px;border-radius:12px;background:#171a21;border:1px solid #2a2f3a;'
    + 'box-shadow:0 16px 38px rgba(0,0,0,.6);color:#eef0f3;'
    + 'font:400 13px/1.4 system-ui,Segoe UI,sans-serif;');

  const head = document.createElement('div');
  head.textContent = 'Höchstens mitgehen bis';
  head.setAttribute('style', 'font-size:11.5px;font-weight:600;letter-spacing:.3px;color:#98a1b0;margin-bottom:8px;');

  const field = document.createElement('input');
  field.type = 'text';
  field.inputMode = 'decimal';
  field.value = maxLimit === null ? '' : String(maxLimit).replace('.', ',');
  field.placeholder = 'z. B. 25';
  field.setAttribute('style', 'width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;'
    + 'border:1px solid #2a2f3a;background:#0f1115;color:#eef0f3;font:600 15px/1 inherit;');

  const hint = document.createElement('div');
  hint.setAttribute('style', 'margin-top:7px;font-size:11px;color:#98a1b0;line-height:1.45;');
  const plus = Number(maxCfg.plus) || 0;

  function refreshHint() {
    const value = parseAmount(field.value);
    if (plus > 0 && value !== null) {
      hint.textContent = 'Mit ' + money(plus) + ' Spielraum bleibt der Gebots-Knopf bis '
        + money(value + plus) + ' stehen.';
    } else if (plus > 0) {
      hint.textContent = 'Spielraum ' + money(plus) + ' – so weit darf darüber hinaus geboten werden.';
    } else {
      hint.textContent = 'Darüber verschwindet der Gebots-Knopf für dieses Los.';
    }
  }
  refreshHint();

  const row = document.createElement('div');
  row.setAttribute('style', 'display:flex;gap:6px;margin-top:10px;');

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'Setzen';
  ok.setAttribute('style', 'flex:1;height:34px;border:none;border-radius:8px;cursor:pointer;'
    + 'background:#ffd400;color:#14151a;font:600 13px inherit;');

  const off = document.createElement('button');
  off.type = 'button';
  off.textContent = 'Aufheben';
  off.setAttribute('style', 'flex:0 0 auto;height:34px;padding:0 12px;border:1px solid #2a2f3a;'
    + 'border-radius:8px;cursor:pointer;background:transparent;color:#98a1b0;font:600 13px inherit;');
  off.hidden = maxLimit === null;

  function commit() {
    const value = parseAmount(field.value);
    maxLimit = (value !== null && value > 0) ? value : null;
    maxLot = testidText('show-product-title');
    closeMaxPop();
    applyMax();
  }

  ok.addEventListener('click', commit);
  off.addEventListener('click', () => { maxLimit = null; closeMaxPop(); applyMax(); });
  field.addEventListener('input', refreshHint);
  field.addEventListener('keydown', (event) => {
    event.stopPropagation();     // Whatnot hoert auf Tasten (Chat, Verknuepfungen)
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') closeMaxPop();
  });
  // Klicks im Kasten gehen niemanden sonst etwas an
  box.addEventListener('mousedown', (event) => event.stopPropagation());
  box.addEventListener('click', (event) => event.stopPropagation());

  row.append(ok, off);
  box.append(head, field, hint, row);
  document.body.appendChild(box);
  field.focus();
  field.select();
}

// Unser Knopf sitzt in derselben Reihe wie der Gebots-Knopf. Whatnot baut die
// Reihe immer wieder neu auf, deshalb wird sie im Takt nachgesehen.
function applyMax() {
  const bid = bidButton();
  const on = maxCfg.on !== false;

  // Keine laufende Auktion (oder abgeschaltet): alles Eigene wieder wegraeumen
  if (!bid || !on) {
    removeById(MAX_BTN_ID);
    removeById(MAX_NOTE_ID);
    closeMaxPop();
    document.documentElement.classList.remove('wnms-bid-off');
    maxBlocked = false;
    // Die Grenze faellt erst, wenn der Gebots-Knopf wirklich weg *bleibt*.
    // Whatnot baut die Reihe zwischendurch neu auf; ein einzelner Takt ohne
    // Knopf ist kein Ende der Auktion und darf die Eingabe nicht wegwerfen.
    if (!bid) {
      maxFehlt++;
      if (maxFehlt >= MAX_GONE_TICKS) { maxLimit = null; maxLot = ''; }
    }
    return;
  }
  maxFehlt = 0;

  const row = bid.parentElement;
  if (!row) return;

  const title = testidText('show-product-title');
  // Neues Los - die Grenze galt nur fuer das vorige
  if (title && title !== maxLot) { maxLimit = null; maxLot = title; closeMaxPop(); }

  const bidMoney = parseMoney(bid.innerText || bid.textContent || '');
  if (bidMoney.currency) maxCurrency = bidMoney.currency;

  const ceiling = maxCeiling();
  maxBlocked = ceiling !== null && bidMoney.value !== null && bidMoney.value > ceiling + 0.001;
  document.documentElement.classList.toggle('wnms-bid-off', maxBlocked);

  let button = document.getElementById(MAX_BTN_ID);
  if (!button) {
    button = document.createElement('button');
    button.id = MAX_BTN_ID;
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (document.getElementById(MAX_POP_ID)) closeMaxPop();
      else openMaxPop();
    });
  }
  if (button.parentElement !== row) row.appendChild(button);

  const gesetzt = maxLimit !== null;
  button.textContent = gesetzt ? 'Max ' + money(maxLimit) : 'Max';
  button.title = gesetzt
    ? 'Höchstens ' + money(maxLimit) + ' für dieses Los'
      + (ceiling !== maxLimit ? ' (mit Spielraum bis ' + money(ceiling) + ')' : '')
    : 'Grenze für dieses Los festlegen';
  styleButton(button, gesetzt
    ? 'background:#ffd400;color:#14151a;'
    : 'background:#ffffff;color:#14151a;');

  // Der gelbe Knopf ist weg - an seine Stelle kommt der Grund dafuer, sonst
  // klafft dort nur eine Luecke und niemand weiss, warum.
  let note = document.getElementById(MAX_NOTE_ID);
  if (maxBlocked) {
    if (!note) {
      note = document.createElement('div');
      note.id = MAX_NOTE_ID;
    }
    if (note.parentElement !== row) row.insertBefore(note, button);
    note.textContent = 'Grenze ' + money(ceiling) + ' erreicht';
    note.setAttribute('style', 'flex:1 1 auto;height:44px;border-radius:999px;'
      + 'display:flex;align-items:center;justify-content:center;'
      + 'background:rgba(255,93,93,.14);border:1px solid rgba(255,93,93,.55);color:#ff9a9a;'
      + 'font:600 13px/1 inherit;white-space:nowrap;overflow:hidden;');
  } else if (note) {
    removeById(MAX_NOTE_ID);
  }
}

ipcRenderer.on('wnms-maxbid', (_event, cfg) => {
  maxCfg = {
    on: !cfg || cfg.on !== false,
    plus: Math.max(0, Number(cfg && cfg.plus) || 0)
  };
  try { applyMax(); } catch (err) {}
});

const pulse = setInterval(() => {
  try { applyMax(); } catch (err) { /* Seite baut gerade um */ }
  pollLot();
  sweepJoin();
  trimUi();                    // nach einer Navigation ist der Stil weg
  if (chatHidden) applyChat(); // Whatnot baut die Oberflaeche neu auf - nachziehen
}, LOT_POLL_MS);

const liveTimer = setInterval(pollLive, LIVE_POLL_MS);

// Beim Verlassen der Seite alles abraeumen: Der Preload laeuft nach jeder
// Navigation neu, ohne das blieben Beobachter und Takt doppelt liegen.
window.addEventListener('pagehide', () => {
  clearInterval(pulse);
  clearInterval(liveTimer);
  clearInterval(settleTimer);
  settleTimer = null;
  if (joinObserver) { joinObserver.disconnect(); joinObserver = null; }
});
