const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duipai', {
  getInfo: () => ipcRenderer.invoke('duipai:info'),
  openDataDirectory: () => ipcRenderer.invoke('duipai:open-data'),
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
