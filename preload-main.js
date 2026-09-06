// Preload des App-Fensters. Der Renderer läuft ohne Node-Zugriff; hierüber
// bekommt er genau die Fähigkeiten, die er braucht: einen Link im echten
// Browser öffnen, Text in die Zwischenablage legen (die Web-Zwischenablage
// setzt einen sicheren Kontext voraus, den file:// nicht bietet), die eigene
// Ablage, die Fensterknöpfe, das Konto und die Selbstaktualisierung.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wnms', {
  openExternal: (url) => ipcRenderer.invoke('wnms-open-external', String(url || '')),
  copy: (text) => ipcRenderer.invoke('wnms-copy', String(text || '')),
  info: () => ipcRenderer.invoke('wnms-app-info'),

  // Dauerhafte Ablage als Datei im Datenordner - unabhaengig von der
  // Ablage-Partition, in der die Whatnot-Seiten ihre Daten halten.
  store: {
    // synchron: der Renderer braucht seinen Bestand schon beim Aufbau
    readSync: () => {
      try { return ipcRenderer.sendSync('wnms-store-read') || {}; } catch (err) { return null; }
    },
    write: (data) => ipcRenderer.invoke('wnms-store-write', data)
  },

  // Eigene Titelleiste: der Systemrahmen ist weg, die Knoepfe sitzen in der App
  window: {
    minimize: () => ipcRenderer.invoke('wnms-window-command', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('wnms-window-command', 'maximize'),
    close: () => ipcRenderer.invoke('wnms-window-command', 'close'),
    state: () => ipcRenderer.invoke('wnms-window-state'),
    onChange: (fn) => ipcRenderer.on('wnms-window', (_event, state) => fn(state))
  },

  // Anmeldung, erkannter Username und Sperre - alles ueber account.js
  account: {
    state: () => ipcRenderer.invoke('wnms-account-state'),
    login: () => ipcRenderer.invoke('wnms-account-login'),
    observe: (username) => ipcRenderer.invoke('wnms-account-observe', String(username || '')),
    forget: () => ipcRenderer.invoke('wnms-account-forget'),
    onChange: (fn) => ipcRenderer.on('wnms-account', (_event, state) => fn(state))
  },

  // Selbstaktualisierung: nachsehen, laden, einspielen - und der Zustand dazu
  update: {
    state: () => ipcRenderer.invoke('wnms-update-state'),
    check: () => ipcRenderer.invoke('wnms-update-check'),
    download: () => ipcRenderer.invoke('wnms-update-download'),
    install: () => ipcRenderer.invoke('wnms-update-install'),
    // Der Rueckruf bekommt nur den Zustand, nicht das IPC-Ereignis selbst
    onChange: (fn) => ipcRenderer.on('wnms-update', (_event, state) => fn(state))
  }
});
