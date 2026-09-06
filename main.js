const { app, BrowserWindow, clipboard, ipcMain, session, shell } = require('electron');
const path = require('path');
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
  win = new BrowserWindow({
    width: 1680,
    height: 980,
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

  win.loadFile(path.join(__dirname, 'index.html'));
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
