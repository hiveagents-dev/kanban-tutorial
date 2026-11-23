const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanban', {
  snapshot: () => ipcRenderer.invoke('board:snapshot'),
  create: input => ipcRenderer.invoke('board:create', input),
  run: () => ipcRenderer.invoke('board:run'),
  stop: () => ipcRenderer.invoke('board:stop'),
  retry: id => ipcRenderer.invoke('board:retry', id),
  onChange(callback) {
    const listener = () => callback();
    ipcRenderer.on('board:changed', listener);
    return () => ipcRenderer.removeListener('board:changed', listener);
  },
});
