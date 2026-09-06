// Preload des App-Fensters. Der Renderer läuft ohne Node-Zugriff; hierüber
// bekommt er genau drei Fähigkeiten: einen Whatnot-Link im echten Browser
// öffnen, Text in die Zwischenablage legen (die Web-Zwischenablage setzt einen
// sicheren Kontext voraus, den file:// nicht bietet) und die
// Selbstaktualisierung bedienen.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wnms', {
  openExternal: (url) => ipcRenderer.invoke('wnms-open-external', String(url || '')),
  copy: (text) => ipcRenderer.invoke('wnms-copy', String(text || '')),

  // Dauerhafte Ablage als Datei im Datenordner - unabhaengig von der
  // Ablage-Partition, in der die Whatnot-Seiten ihre Daten halten.
  store: {
    // synchron: der Renderer braucht seinen Bestand schon beim Aufbau
    readSync: () => {
      try { return ipcRenderer.sendSync('wnms-store-read') || {}; } catch (err) { return null; }
    },
    write: (data) => ipcRenderer.invoke('wnms-store-write', data)
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
