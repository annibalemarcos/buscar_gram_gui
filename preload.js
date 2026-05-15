const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (apiId, apiHash) => ipcRenderer.invoke('config:save', { apiId, apiHash }),

  pickFile: (defaultName, format) =>
    ipcRenderer.invoke('dialog:pickFile', { defaultName, format }),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  resolveOutput: (query, format, customPath) =>
    ipcRenderer.invoke('output:resolve', { query, format, customPath }),
  revealInFolder: (p) => ipcRenderer.invoke('output:reveal', p),

  startSearch: (payload) => ipcRenderer.invoke('search:start', payload),
  stopSearch: () => ipcRenderer.invoke('search:stop'),

  sendInput: (data) => ipcRenderer.invoke('pty:input', data),
  resize: (cols, rows) => ipcRenderer.invoke('pty:resize', { cols, rows }),

  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, info) => cb(info)),
});
