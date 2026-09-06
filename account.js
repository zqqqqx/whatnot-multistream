/* ================= Konto: Anmeldung, Name, Sperre =================
 *
 * Alles, was mit dem eigenen Whatnot-Konto zu tun hat, liegt hier an einer
 * Stelle: das Anmeldefenster, das Erkennen des Namens, das Merken ueber
 * Neustarts hinweg und die Pruefung gegen die Sperrliste. Der Rest der App
 * fragt nur noch state() ab und ruft openLogin() bzw. observe() auf.
 *
 * Warum der Name ueberhaupt gebraucht wird: Die App erkennt daran die eigenen
 * Zuschlaege (fuer die Versand-Buendelung) - und die Sperrliste haengt daran.
 */
const { BrowserWindow } = require('electron');
const bans = require('./bans.js');
const store = require('./store.js');

const ACCOUNT_KEY = 'wnms.account.v1';
const LOGIN_URL = 'https://www.whatnot.com/login';
const DETECT_EVERY_MS = 1200;
const SUCCESS_SHOW_MS = 1500;

/* Laeuft in der Whatnot-Seite. Whatnot legt den angemeldeten Nutzer selbst in
 * die Seite: window.__whatnot__.loggerContext.usr.name ist der Username (nicht
 * der Anzeigename). Zweiter Weg sind die Analyse-Merkmale im localStorage,
 * dritter das rohe HTML - falls Whatnot das Fenster-Objekt einmal umbenennt. */
const DETECT_JS = [
  '(() => {',
  '  function clean(v) {',
  '    v = String(v == null ? "" : v).trim().replace(/^@/, "");',
  '    return /^[A-Za-z0-9_.-]{2,40}$/.test(v) ? v : "";',
  '  }',
  '  try {',
  '    var w = window.__whatnot__;',
  '    var usr = w && w.loggerContext && w.loggerContext.usr;',
  '    var a = clean(usr && usr.name);',
  '    if (a) return a;',
  '  } catch (e) {}',
  '  try {',
  '    var raw = localStorage.getItem("ajs_user_traits");',
  '    if (raw) { var b = clean(JSON.parse(raw).username); if (b) return b; }',
  '  } catch (e) {}',
  '  try {',
  '    var hit = document.documentElement.innerHTML.match(/"loggerContext":[^]{0,400}?"name":"([^"]+)"/);',
  '    if (hit) { var c = clean(hit[1]); if (c) return c; }',
  '  } catch (e) {}',
  '  return "";',
  '})()'
].join('\n');

// Erfolgsmeldung im Anmeldefenster - kurz sichtbar, dann geht das Fenster zu.
function successJs(username) {
  return [
    '(() => {',
    '  try {',
    '    var box = document.createElement("div");',
    '    box.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(9,11,15,.94);color:#eef0f3;font:600 15px Segoe UI,system-ui,sans-serif");',
    '    var card = document.createElement("div");',
    '    card.setAttribute("style", "text-align:center;padding:26px 30px;border:1px solid #2a2f3a;'
      + 'border-radius:14px;background:#171a21");',
    '    var tick = document.createElement("div");',
    '    tick.textContent = "\\u2713";',
    '    tick.setAttribute("style", "width:46px;height:46px;margin:0 auto 12px;border-radius:50%;'
      + 'background:#ffd400;color:#14151a;font-size:26px;line-height:46px");',
    '    var line = document.createElement("div");',
    '    line.textContent = "Angemeldet als " + ' + JSON.stringify(username) + ';',
    '    var sub = document.createElement("div");',
    '    sub.textContent = "Streams werden neu geladen \\u2026";',
    '    sub.setAttribute("style", "margin-top:6px;font-weight:400;font-size:13px;color:#98a1b0");',
    '    card.appendChild(tick); card.appendChild(line); card.appendChild(sub);',
    '    box.appendChild(card);',
    '    document.body.appendChild(box);',
    '  } catch (e) {}',
    '})()'
  ].join('\n');
}

let current = null;        // { username, banned, at }
const listeners = [];
let loginWin = null;

function emit() {
  const snapshot = state();
  for (const fn of listeners) {
    try { fn(snapshot); } catch (err) { /* ein Zuhoerer darf den Rest nicht mitreissen */ }
  }
}

function load() {
  if (current) return current;
  const saved = store.get(ACCOUNT_KEY, null);
  current = (saved && typeof saved === 'object')
    ? { username: String(saved.username || ''), banned: Boolean(saved.banned), at: Number(saved.at) || 0 }
    : { username: '', banned: false, at: 0 };
  return current;
}

function save() {
  try { store.set(ACCOUNT_KEY, current); } catch (err) { /* dann steht es nur in dieser Sitzung */ }
}

function state() {
  const acc = load();
  return {
    username: acc.username,
    loggedIn: Boolean(acc.username),
    banned: Boolean(acc.banned),
    at: acc.at
  };
}

// Einmal gesperrt, bleibt gesperrt: Das Merkmal steht in der Ablage, wird bei
// jedem Start gelesen und bei jeder erkannten Anmeldung neu geprueft. Ein
// Neustart oder ein zweiter Anmeldeversuch mit demselben Konto hilft also nicht.
function locked() {
  return Boolean(load().banned);
}

/* Der einzige Weg, an dem ein erkannter Name in die App kommt. Egal ob er aus
 * dem Anmeldefenster stammt oder nebenbei beim Live-Abgleich aufgeschnappt
 * wurde - hier wird normalisiert, gespeichert und gegen die Sperrliste
 * gehalten. Rueckgabe sagt, was sich geaendert hat. */
async function observe(rawName) {
  const acc = load();
  const name = String(rawName || '').trim().replace(/^@/, '');
  if (!name) return { changed: false, banned: acc.banned, username: acc.username };

  const changed = bans.normalize(name) !== bans.normalize(acc.username);
  acc.username = name;
  acc.at = Date.now();

  let banned = false;
  try { banned = await bans.isBanned(name); } catch (err) { banned = false; }
  // Eine bestehende Sperre wird nur durch ein *anderes*, freies Konto geloest -
  // sonst waere sie durch simples Abmelden erledigt.
  acc.banned = banned || (acc.banned && !changed);

  save();
  emit();
  return { changed, banned: acc.banned, username: acc.username };
}

// Konto wechseln: den gemerkten Namen vergessen. Eine Sperre bleibt bestehen,
// bis ein anderes, freies Konto erkannt wird (siehe observe).
function forget() {
  const acc = load();
  acc.username = '';
  acc.at = 0;
  save();
  emit();
}

function onChange(fn) {
  if (typeof fn === 'function') listeners.push(fn);
}

/* ---- Anmeldefenster ----
 *
 * Eigenes Fenster in derselben Ablage-Partition wie die Kacheln: Was hier
 * angemeldet wird, gilt sofort auch dort. Beobachtet wird die Seite, bis ein
 * Name auftaucht; dann kurz Bescheid geben und zumachen. Wird das Fenster
 * vorher geschlossen, gilt der Vorgang als abgebrochen - dann wird auch nichts
 * neu geladen.
 */
function openLogin(parent, partition) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return Promise.resolve({ result: 'busy' });
  }
  if (locked()) return Promise.resolve({ result: 'locked' });

  const before = bans.normalize(load().username);

  loginWin = new BrowserWindow({
    width: 520,
    height: 800,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    title: 'Bei Whatnot anmelden',
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      partition: partition,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const win = loginWin;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let busy = false;
    // Beim Oeffnen kann bereits eine Anmeldung bestehen. Dann soll nicht der
    // Eindruck entstehen, gerade sei etwas passiert - erkannt wird das daran,
    // dass der Name sofort da ist und derselbe ist wie bisher.
    const startedAt = Date.now();

    function finish(payload) {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(payload);
    }

    async function look() {
      if (settled || busy) return;
      if (win.isDestroyed()) { finish({ result: 'cancelled' }); return; }
      busy = true;
      let name = '';
      try { name = await win.webContents.executeJavaScript(DETECT_JS, true); } catch (err) { name = ''; }
      busy = false;
      if (!name || settled) return;

      clearInterval(timer);
      const info = await observe(name);
      const wasAlready = bans.normalize(name) === before && Date.now() - startedAt < 4000;

      if (!win.isDestroyed()) {
        try { await win.webContents.executeJavaScript(successJs(name), true); } catch (err) { /* Seite weg */ }
        setTimeout(() => { if (!win.isDestroyed()) win.close(); }, SUCCESS_SHOW_MS);
      }

      finish({
        result: info.banned ? 'banned' : 'ok',
        username: name,
        // Neu geladen wird nur, wenn sich an der Anmeldung wirklich etwas geaendert hat
        reload: !info.banned && (info.changed || !wasAlready),
        banned: info.banned
      });
    }

    win.on('closed', () => {
      if (loginWin === win) loginWin = null;
      finish({ result: 'cancelled' });
    });

    win.loadURL(LOGIN_URL).catch(() => {});
    timer = setInterval(look, DETECT_EVERY_MS);
    win.webContents.on('did-finish-load', look);
  });
}

module.exports = { state, observe, forget, onChange, openLogin, locked, DETECT_JS, ACCOUNT_KEY };
