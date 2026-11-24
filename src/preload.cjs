const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanban', {
  snapshot: () => ipcRenderer.invoke('board:snapshot'),
  create: input => ipcRenderer.invoke('board:create', input),
  edit: (id, input) => ipcRenderer.invoke('board:edit', id, input),
  copy: (id, receiptId) => ipcRenderer.invoke('board:copy', id, receiptId),
  run: id => ipcRenderer.invoke('board:run', id),
  stop: () => ipcRenderer.invoke('board:stop'),
  retry: id => ipcRenderer.invoke('board:retry', id),
  findSimilar: input => ipcRenderer.invoke('board:findSimilar', input),
  assistantSnapshot: () => ipcRenderer.invoke('board:assistantSnapshot'),
  askAssistant: input => ipcRenderer.invoke('board:askAssistant', input),
  decideAssistant: input => ipcRenderer.invoke('board:decideAssistant', input),
  onChange(callback) {
    const listener = () => callback();
    ipcRenderer.on('board:changed', listener);
    return () => ipcRenderer.removeListener('board:changed', listener);
  },
});
