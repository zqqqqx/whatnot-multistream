// Preload des App-Fensters. Der Renderer läuft ohne Node-Zugriff; hierüber
// bekommt er genau zwei Fähigkeiten: einen Whatnot-Link im echten Browser
// öffnen und Text in die Zwischenablage legen (die Web-Zwischenablage setzt
// einen sicheren Kontext voraus, den file:// nicht bietet).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wnms', {
  openExternal: (url) => ipcRenderer.invoke('wnms-open-external', String(url || '')),
  copy: (text) => ipcRenderer.invoke('wnms-copy', String(text || ''))
});
