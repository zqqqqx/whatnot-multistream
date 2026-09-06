const { app, BrowserWindow, clipboard, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// Streams sollen ohne Klick starten
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const PARTITION = 'persist:whatnot';

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

function createWindow() {
  // Zuletzt eingestellte Fenstergroesse und -lage wieder herstellen
  const saved = readStore()[WINDOW_KEY] || {};
  const usable = Number.isFinite(saved.width) && Number.isFinite(saved.height);

  win = new BrowserWindow({
    width: usable ? Math.max(900, saved.width) : 1680,
    height: usable ? Math.max(600, saved.height) : 980,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
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

function sendUpdate(state) {
  updateState = state;
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('wnms-update', state); } catch (err) { /* Fenster geht gerade zu */ }
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
  if (!app.isPackaged) { sendUpdate({ state: 'dev' }); return; }
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

// Ein Live-Link aus einer Kachel im echten Browser oeffnen. Nur whatnot.com,
// damit ueber diesen Weg nichts anderes gestartet werden kann.
/* ================= Dauerhafte Ablage =================
 *
 * Die Streamerliste lag frueher im localStorage des Fensters. Das Fenster
 * benutzt aber dieselbe Ablage-Partition wie die Streams selbst - die
 * Streamerliste stand also mitten in mehreren hundert Megabyte Whatnot-Daten.
 * Wird davon etwas verworfen (Chromium raeumt bei Platzmangel je Herkunft auf,
 * und ein Loeschen der Seitendaten trifft alles darin), ist die Liste weg.
 *
 * Sie liegt deshalb jetzt als eigene Datei im Datenordner der App - unabhaengig
 * von allem, was Whatnot dort treibt. Geschrieben wird ueber eine Nebendatei,
 * die anschliessend in einem Zug an ihren Platz gezogen wird: Ein Absturz
 * mitten im Schreiben kann so keine halbe Datei hinterlassen. Die vorige
 * Fassung bleibt als .bak liegen und wird gelesen, falls die Hauptdatei
 * unbrauchbar ist.
 */
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

function readStore() {
  try {
    return readFileStore(storePath());
  } catch (err) { /* unten weiter mit der Sicherung */ }

  try {
    const data = readFileStore(storePath('.bak'));
    // Aus der Sicherung gelesen heisst: die Hauptdatei taugt nichts. Sie wird
    // sofort wiederhergestellt - sonst wuerde sie beim naechsten Schreiben als
    // vermeintlich gute Fassung ueber die Sicherung kopiert.
    try { writeStore(data, true); } catch (err) { /* dann eben beim naechsten Mal */ }
    return data;
  } catch (err) { /* auch die Sicherung ist nichts */ }

  return {};
}

function writeStore(data, skipBackup) {
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

// Synchron, damit der Renderer seinen Bestand schon beim Aufbau hat
ipcMain.on('wnms-store-read', (event) => {
  try { event.returnValue = readStore(); } catch (err) { event.returnValue = {}; }
});

// Zusammenfuehren statt ersetzen: Fenstergroesse schreibt der Hauptprozess,
// alles andere der Renderer. Wuerde jeder die ganze Ablage ueberschreiben,
// loeschte einer dem anderen seine Eintraege.
ipcMain.handle('wnms-store-write', (_event, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  try { writeStore(Object.assign(readStore(), data)); return true; } catch (err) { return false; }
});

const WINDOW_KEY = 'wnms.window.v1';

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    writeStore(Object.assign(readStore(), {
      [WINDOW_KEY]: {
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        maximized: win.isMaximized()
      }
    }));
  } catch (err) { /* dann bleibt die alte Groesse stehen */ }
}

// Zwischenablage: nur Text, und nur was der Renderer selbst zusammengestellt hat
ipcMain.handle('wnms-copy', (_event, text) => {
  const value = String(text || '');
  if (!value) return false;
  clipboard.writeText(value);
  return true;
});

ipcMain.handle('wnms-open-external', (_event, url) => {
  if (/^https:\/\/(www\.)?whatnot\.com\//i.test(url)) shell.openExternal(url);
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
  prepareSession(session.fromPartition(PARTITION));
  prepareSession(session.defaultSession);
  createWindow();
  setupUpdater();

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
