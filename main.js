const { app, BrowserWindow, clipboard, ipcMain, session, shell } = require('electron');
const path = require('path');

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
