const { app, BrowserWindow, clipboard, ipcMain, Menu, screen, session, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const store = require('./store.js');
const account = require('./account.js');
const bans = require('./bans.js');

// Streams sollen ohne Klick starten
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const PARTITION = 'persist:whatnot';
const REPO_URL = 'https://github.com/zqqqqx/whatnot-multistream';

let win = null;

// Electron-Kennung aus dem User-Agent entfernen, damit Whatnot uns als normalen Chrome sieht
function cleanUserAgent(ua) {
  return ua
    .replace(/ Electron\/[\d.]+/i, '')
    .replace(/ whatnot-multistream\/[\d.]+/i, '');
}

function prepareSession(ses) {
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));

  // Einbett-Sperren entfernen. Fuer <webview> ist das nicht noetig, aber es sorgt
  // dafuer, dass auch iframes innerhalb der Whatnot-Seiten sauber laden.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    for (const key of Object.keys(headers)) {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') delete headers[key];
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') {
        const value = [].concat(headers[key]).join('; ');
        if (/frame-ancestors/i.test(value)) {
          headers[key] = [value.replace(/frame-ancestors[^;]*;?/gi, '')];
        }
      }
    }
    callback({ responseHeaders: headers });
  });
}

const WINDOW_KEY = 'wnms.window.v1';

/* Gemerkte Lage nur uebernehmen, wenn das Fenster dort auch zu sehen waere.
 * Sonst startet die App unsichtbar - etwa weil der zweite Bildschirm nicht mehr
 * angeschlossen ist, sich die Aufloesung geaendert hat oder das Fenster beim
 * letzten Mal ueber den Rand geschoben wurde. Verlangt wird nur, dass ein
 * ordentliches Stueck der Titelleiste auf einem Bildschirm liegt - daran laesst
 * es sich zurueckholen. */
function usablePlace(saved) {
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return false;
  const width = Number.isFinite(saved.width) ? saved.width : 1680;
  const bar = { x: saved.x, y: saved.y, width: width, height: 60 };
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(bar.x + bar.width, area.x + area.width) - Math.max(bar.x, area.x);
    const overlapY = Math.min(bar.y + bar.height, area.y + area.height) - Math.max(bar.y, area.y);
    return overlapX >= 120 && overlapY >= 30;
  });
}

function createWindow() {
  // Zuletzt eingestellte Fenstergroesse und -lage wieder herstellen
  const saved = store.get(WINDOW_KEY, {}) || {};
  const usable = Number.isFinite(saved.width) && Number.isFinite(saved.height);
  const placed = usablePlace(saved);

  win = new BrowserWindow({
    width: usable ? Math.max(900, saved.width) : 1680,
    height: usable ? Math.max(600, saved.height) : 980,
    x: placed ? saved.x : undefined,
    y: placed ? saved.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    // Ohne Systemrahmen: die Kopfleiste der App ist zugleich die Titelleiste
    // (siehe .topbar in styles.css, -webkit-app-region: drag). thickFrame bleibt
    // an, damit das Fenster an den Kanten weiter greifbar ist und seinen
    // Schlagschatten behaelt.
    frame: false,
    autoHideMenuBar: true,
    title: 'Whatnot Multistream',
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      partition: PARTITION
    }
  });

  if (saved.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'index.html'));

  // Die eigenen Fensterknoepfe muessen wissen, ob gerade maximiert ist
  const tellState = () => {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('wnms-window', { maximized: win.isMaximized(), fullScreen: win.isFullScreen() }); }
    catch (err) { /* Fenster geht gerade zu */ }
  };
  win.on('maximize', tellState);
  win.on('unmaximize', tellState);
  win.on('enter-full-screen', tellState);
  win.on('leave-full-screen', tellState);
  win.webContents.on('did-finish-load', tellState);

  // Nicht bei jedem Pixel schreiben, sondern wenn das Schieben vorbei ist
  let boundsTimer = null;
  const remember = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  win.on('close', () => { clearTimeout(boundsTimer); saveBounds(); });
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    store.set(WINDOW_KEY, {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      maximized: win.isMaximized()
    });
  } catch (err) { /* dann bleibt die alte Groesse stehen */ }
}

/* ================= Eigene Fensterknoepfe =================
 * Der Systemrahmen ist weg (frame: false). Minimieren, Maximieren und
 * Schliessen sitzen jetzt rechts in der Kopfleiste und melden sich hierher.
 * Das Verschieben und der Doppelklick auf die Leiste erledigt Chromium selbst
 * ueber -webkit-app-region: drag. */
ipcMain.handle('wnms-window-command', (event, command) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return null;
  if (command === 'minimize') target.minimize();
  else if (command === 'maximize') { if (target.isMaximized()) target.unmaximize(); else target.maximize(); }
  else if (command === 'close') target.close();
  return { maximized: target.isMaximized() };
});

ipcMain.handle('wnms-window-state', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return { maximized: false };
  return { maximized: target.isMaximized(), fullScreen: target.isFullScreen() };
});

/* ================= Selbstaktualisierung =================
 *
 * Die App schaut bei GitHub nach, ob es eine neuere Fassung gibt. Geladen wird
 * nichts von allein: Erst meldet sie, dass etwas da ist, und erst auf Klick
 * wird heruntergeladen und installiert. Bezugsquelle ist der Release-Bereich
 * des eigenen Projekts (siehe "publish" in der package.json); dort liegen der
 * Installer, die latest.yml mit Version und Pruefsumme und die blockmap, mit
 * der nur die geaenderten Teile geladen werden.
 */
const UPDATE_INTERVAL = 3 * 60 * 60 * 1000; // alle drei Stunden nachsehen

let updateState = { state: 'idle' };
let updateAsked = false; // hat der Nutzer selbst nachgesehen? Dann Antwort zeigen

function sendUpdate(state) {
  updateState = Object.assign({ at: Date.now(), asked: updateAsked }, state);
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('wnms-update', updateState); } catch (err) { /* Fenster geht gerade zu */ }
  }
}

function setupUpdater() {
  // Im Quelltextbetrieb gibt es nichts zu aktualisieren - autoUpdater wuerde
  // dort nur ueber eine fehlende dev-app-update.yml stolpern.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;          // der Nutzer entscheidet
  autoUpdater.autoInstallOnAppQuit = true;   // Geladenes beim Beenden einspielen
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    sendUpdate({ state: 'available', version: info.version, notes: String(info.releaseNotes || '').slice(0, 400) });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdate({ state: 'current', version: app.getVersion() });
  });
  autoUpdater.on('download-progress', (p) => {
    sendUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdate({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    sendUpdate({ state: 'error', message: String((err && err.message) || err).slice(0, 200) });
  });

  const look = () => { autoUpdater.checkForUpdates().catch(() => { /* der Fehlerkanal meldet es */ }); };
  setTimeout(look, 8000);                  // nicht gleich im Startgedraenge
  setInterval(look, UPDATE_INTERVAL);
}

ipcMain.handle('wnms-update-state', () => updateState);

ipcMain.handle('wnms-update-check', () => {
  updateAsked = true;
  if (!app.isPackaged) { sendUpdate({ state: 'dev', version: app.getVersion() }); return; }
  sendUpdate({ state: 'checking' });
  autoUpdater.checkForUpdates().catch(() => {});
});

ipcMain.handle('wnms-update-download', () => {
  if (!app.isPackaged) return;
  sendUpdate({ state: 'downloading', percent: 0 });
  autoUpdater.downloadUpdate().catch(() => {});
});

ipcMain.handle('wnms-update-install', () => {
  if (!app.isPackaged) return;
  // false = Installer sichtbar (der ist nicht signiert, da soll man sehen was laeuft)
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('wnms-app-info', () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
  repo: REPO_URL,
  electron: process.versions.electron
}));

/* ================= Dauerhafte Ablage ================= */

// Synchron, damit der Renderer seinen Bestand schon beim Aufbau hat
ipcMain.on('wnms-store-read', (event) => {
  try { event.returnValue = store.read(); } catch (err) { event.returnValue = {}; }
});

ipcMain.handle('wnms-store-write', (_event, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  try { store.merge(data); return true; } catch (err) { return false; }
});

/* ================= Konto ================= */

account.onChange((state) => {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('wnms-account', state); } catch (err) {}
});

ipcMain.handle('wnms-account-state', () => account.state());

// Der Name, den der Renderer beim Live-Abgleich nebenbei aus einer Whatnot-Seite
// gelesen hat. Hier laeuft er durch dieselbe Pruefung wie nach dem Anmelden -
// damit greift die Sperre auch ohne neuen Anmeldevorgang.
ipcMain.handle('wnms-account-observe', async (_event, username) => {
  const info = await account.observe(String(username || ''));
  return Object.assign({}, account.state(), { changed: info.changed });
});

ipcMain.handle('wnms-account-forget', () => { account.forget(); return account.state(); });

ipcMain.handle('wnms-account-login', async () => {
  if (account.locked()) return { result: 'locked' };
  return account.openLogin(win, PARTITION);
});

/* Die Sperrliste liegt im Netz, nicht in der App (siehe bans.js). Sie wird beim
 * Start und danach halbstuendlich geholt und das eigene Konto jedes Mal neu
 * dagegen gehalten: Eintragen und Streichen wirkt damit im laufenden Betrieb,
 * ohne dass jemand eine neue Fassung installieren muss. */
function watchBans() {
  const look = () => { account.recheck().catch(() => { /* beim naechsten Mal wieder */ }); };
  setTimeout(look, 4000);           // nicht ins Startgedraenge
  setInterval(look, bans.REFRESH_MS);
}

/* ================= Kleinkram ================= */

// Zwischenablage: nur Text, und nur was der Renderer selbst zusammengestellt hat
ipcMain.handle('wnms-copy', (_event, text) => {
  const value = String(text || '');
  if (!value) return false;
  clipboard.writeText(value);
  return true;
});

// Einen Link im echten Browser oeffnen. Nur die eigenen Adressen, damit ueber
// diesen Weg nichts anderes gestartet werden kann.
const OPEN_ALLOWED = [
  /^https:\/\/(www\.)?whatnot\.com\//i,
  /^https:\/\/github\.com\/zqqqqx\/whatnot-multistream(\/|$)/i
];

ipcMain.handle('wnms-open-external', (_event, url) => {
  if (account.locked()) return false;
  const value = String(url || '');
  if (!OPEN_ALLOWED.some((rule) => rule.test(value))) return false;
  shell.openExternal(value);
  return true;
});

// Zwei laufende Fenster wuerden sich beim Schreiben in die Quere kommen (und
// haetten ausserdem alle Streams doppelt offen). Der zweite Start holt deshalb
// nur das vorhandene Fenster nach vorn.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

app.whenReady().then(() => {
  // Ohne Systemrahmen gibt es auch keine Menuezeile - und die Alt-Taste, an der
  // die Lupe haengt, soll nichts anderes ausloesen.
  Menu.setApplicationMenu(null);

  prepareSession(session.fromPartition(PARTITION));
  prepareSession(session.defaultSession);
  createWindow();
  setupUpdater();
  watchBans();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Popups (z. B. Login ueber Google/Apple) in einem eigenen Fenster derselben Session zulassen
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 560,
      height: 760,
      autoHideMenuBar: true,
      backgroundColor: '#0f1115'
    }
  }));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
