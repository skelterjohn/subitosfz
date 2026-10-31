import { contextBridge, ipcRenderer } from 'electron'

// Subscribes to a main->renderer menu event, returning an unsubscribe
// function (React effect cleanup) rather than exposing ipcRenderer itself
// across the context bridge.
function onMenuEvent(channel: string, callback: () => void): () => void {
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getServerPort: (): Promise<number> => ipcRenderer.invoke('get-server-port'),
  getStartTime: (): Promise<number> => ipcRenderer.invoke('get-start-time'),
  chooseSf2File: (): Promise<string | null> => ipcRenderer.invoke('choose-sf2-file'),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('choose-directory'),
  chooseSfzFile: (): Promise<string | null> => ipcRenderer.invoke('choose-sfz-file'),
  getLastSfzFile: (): Promise<string | null> => ipcRenderer.invoke('get-last-sfz-file'),
  setLastSfzFile: (filePath: string | null): Promise<void> =>
    ipcRenderer.invoke('set-last-sfz-file', filePath),
  readAudioFile: (sfzFilePath: string, relativeSamplePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('read-audio-file', sfzFilePath, relativeSamplePath),
  onMenuImport: (callback: () => void): (() => void) => onMenuEvent('menu-import', callback),
  onMenuOpen: (callback: () => void): (() => void) => onMenuEvent('menu-open', callback),
  onMenuSave: (callback: () => void): (() => void) => onMenuEvent('menu-save', callback),
  onMenuSaveAs: (callback: () => void): (() => void) => onMenuEvent('menu-save-as', callback)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
