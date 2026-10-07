const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duipai', {
  getInfo: () => ipcRenderer.invoke('duipai:info'),
  openDataDirectory: () => ipcRenderer.invoke('duipai:open-data'),
  openBackendLog: () => ipcRenderer.invoke('duipai:open-log'),
  isFullscreen: () => ipcRenderer.invoke('duipai:fullscreen'),
  setFullscreen: value => ipcRenderer.invoke('duipai:fullscreen', value),
  onFullscreenChange(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('duipai:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('duipai:fullscreen-changed', listener);
  },
  onBeforeClose(callback) {
    const listener = async (_event, id) => {
      try {
        await callback();
        ipcRenderer.send('duipai:close-ready', { id });
      } catch (error) {
        ipcRenderer.send('duipai:close-ready', { id, error: String(error?.message || error) });
      }
    };
    ipcRenderer.on('duipai:before-close', listener);
    return () => ipcRenderer.removeListener('duipai:before-close', listener);
  }
});
