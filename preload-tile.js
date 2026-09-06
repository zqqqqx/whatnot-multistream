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

// Die Lupe hängt an der Strg-Taste. Die App muss dafür wissen, wo der Zeiger
// gerade steht – auch bevor die Taste gedrückt wird, denn die Lupe soll sofort
// an der richtigen Stelle erscheinen.
//
// "track" ist an, solange diese Kachel im großen Modus läuft: dann meldet die
// Seite die Zeigerposition sparsam (alle 50 ms), bei aktiver Lupe jede Bewegung.
const TRACK_INTERVAL = 50;

let trackOn = false;
let lensOn = false;
let ctrlHeld = false;
let lastPoint = { x: 0, y: 0 };
let lastSent = 0;

ipcRenderer.on('wnms-track', (_event, on) => {
  trackOn = Boolean(on);
  if (!trackOn) releaseCtrl();
});
ipcRenderer.on('wnms-lens', (_event, on) => { lensOn = Boolean(on); });

function releaseCtrl() {
  if (!ctrlHeld) return;
  ctrlHeld = false;
  ipcRenderer.sendToHost('wnms-lensoff', lastPoint);
}

// Die Kachel verschluckt sonst alle Mausereignisse: die rechte Maustaste wird
// deshalb an die App weitergereicht (Rechtsklick = Menü, Rechtsklick+Ziehen =
// Kachel umsortieren). In der Capture-Phase, damit Whatnots eigene Handler
// nichts abfangen können.
let rightDown = false;

window.addEventListener('mousedown', (event) => {
  // Während die Lupe läuft, soll ein Klick nicht auch noch die Seite bedienen
  if (lensOn && event.button === 0) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.button !== 2) return;
  rightDown = true;
  ipcRenderer.sendToHost('wnms-rdown', { x: event.clientX, y: event.clientY });
}, true);

window.addEventListener('click', (event) => {
  if (!lensOn) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

window.addEventListener('mousemove', (event) => {
  lastPoint = { x: event.clientX, y: event.clientY };

  if (lensOn) {
    ipcRenderer.sendToHost('wnms-lensmove', lastPoint);
  } else if (trackOn) {
    const now = Date.now();
    if (now - lastSent >= TRACK_INTERVAL) {
      lastSent = now;
      ipcRenderer.sendToHost('wnms-lensmove', lastPoint);
    }
  }

  if (!rightDown) return;
  ipcRenderer.sendToHost('wnms-rmove', lastPoint);
}, true);

window.addEventListener('mouseup', (event) => {
  if (event.button !== 2 || !rightDown) return;
  rightDown = false;
  ipcRenderer.sendToHost('wnms-rup', { x: event.clientX, y: event.clientY });
}, true);

// Strg gedrückt = Lupe an, losgelassen = Lupe weg.
// keydown wiederholt sich beim Halten, deshalb der ctrlHeld-Merker.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Control' || ctrlHeld) return;
  ctrlHeld = true;
  ipcRenderer.sendToHost('wnms-lenson', lastPoint);
}, true);

window.addEventListener('keyup', (event) => {
  if (event.key !== 'Control') return;
  releaseCtrl();
}, true);

// Verlässt die Seite den Fokus, kommt kein keyup mehr an – Lupe trotzdem beenden
window.addEventListener('blur', releaseCtrl);

// Mausrad steuert die Lupe – die Seite darf dabei nicht mitscrollen.
// passive:false, sonst ließe sich preventDefault() nicht aufrufen.
window.addEventListener('wheel', (event) => {
  if (!lensOn) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.sendToHost('wnms-lenswheel', { deltaY: event.deltaY, shift: event.shiftKey });
}, { capture: true, passive: false });

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

// "Gebot: 8 €" -> "8 €" | "Der Versand betraegt 6,05 € + Steuern" -> "6,05 €"
function parseMoney(text) {
  const hit = /(\d[\d.,]*)\s*(€|\$|£|EUR|USD)|(€|\$|£)\s*(\d[\d.,]*)/.exec(text || '');
  if (!hit) return '';
  return hit[1] ? hit[1] + ' ' + hit[2] : hit[3] + hit[4];
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
  const shipping = testidText('show-shipping-info');
  if (!title && !bidText && !timer) return null; // Auktionsteil noch nicht da

  // Der Hammer wird doppelt gemeldet: als Zustand ("... hat gewonnen!") und als
  // eigene Zeile ("... hat die Auktion gewonnen!"). Die eigene Zeile ist
  // eindeutiger, deshalb hat sie Vorrang.
  const status = parseStatus(statusText);
  const winner = parseStatus(winnerText);
  const done = winner.zuschlag || status.zuschlag;
  return {
    title: title,
    rest: parseClock(timer),          // Sekunden bis zum Hammer, null = kein Countdown
    bid: parseMoney(bidText),         // was das naechste Gebot kostet
    leader: (done && winner.wer) || status.wer || winner.wer,
    done: done,
    shipping: parseMoney(shipping),   // Versandkosten dieses Verkaeufers
    statusText: (winnerText || statusText).slice(0, 90)
  };
}

let lastLot = '';

function pollLot() {
  let lot = null;
  try { lot = readLot(); } catch (err) { lot = null; }
  const signature = lot ? [lot.title, lot.rest, lot.bid, lot.leader, lot.done, lot.shipping].join('|') : '';
  if (signature === lastLot) return;
  lastLot = signature;
  try { ipcRenderer.sendToHost('wnms-lot', lot); } catch (err) {}
}



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

setInterval(() => {
  pollLot();
  if (chatHidden) applyChat(); // Whatnot baut die Oberflaeche neu auf - nachziehen
}, LOT_POLL_MS);
