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
  // Drives whether the renderer draws its own File-menu bar: macOS keeps
  // the native application menu in the system menu bar (see main/index.ts),
  // every other platform hides that native menu row and gets the
  // self-drawn one instead - see TopMenuBar.tsx.
  platform: process.platform,
  quitApp: (): Promise<void> => ipcRenderer.invoke('quit-app'),
  getServerPort: (): Promise<number> => ipcRenderer.invoke('get-server-port'),
  getStartTime: (): Promise<number> => ipcRenderer.invoke('get-start-time'),
  getWorkingSfzPath: (originalPath: string): Promise<string> =>
    ipcRenderer.invoke('get-working-sfz-path', originalPath),
  chooseSf2File: (): Promise<string | null> => ipcRenderer.invoke('choose-sf2-file'),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('choose-directory'),
  chooseSfzFile: (): Promise<string | null> => ipcRenderer.invoke('choose-sfz-file'),
  getLastSfzFile: (): Promise<string | null> => ipcRenderer.invoke('get-last-sfz-file'),
  setLastSfzFile: (filePath: string | null): Promise<void> =>
    ipcRenderer.invoke('set-last-sfz-file', filePath),
  getLastPivot: (): Promise<{ axis: string; value: string } | null> =>
    ipcRenderer.invoke('get-last-pivot'),
  setLastPivot: (axis: string, value: string): Promise<void> =>
    ipcRenderer.invoke('set-last-pivot', axis, value),
  readAudioFile: (sfzFilePath: string, relativeSamplePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('read-audio-file', sfzFilePath, relativeSamplePath),
  listDirectory: (sfzFilePath: string): Promise<string[]> =>
    ipcRenderer.invoke('list-directory', sfzFilePath),
  deleteSampleFile: (sfzFilePath: string, relativeSamplePath: string): Promise<void> =>
    ipcRenderer.invoke('delete-sample-file', sfzFilePath, relativeSamplePath),
  chooseAudioFile: (): Promise<string | null> => ipcRenderer.invoke('choose-audio-file'),
  chooseMuseScoreFile: (): Promise<string | null> => ipcRenderer.invoke('choose-musescore-file'),
  onMenuNew: (callback: () => void): (() => void) => onMenuEvent('menu-new', callback),
  onMenuImport: (callback: () => void): (() => void) => onMenuEvent('menu-import', callback),
  onMenuImportRecording: (callback: () => void): (() => void) =>
    onMenuEvent('menu-import-recording', callback),
  onMenuOpen: (callback: () => void): (() => void) => onMenuEvent('menu-open', callback),
  onMenuSave: (callback: () => void): (() => void) => onMenuEvent('menu-save', callback),
  onMenuSaveAs: (callback: () => void): (() => void) => onMenuEvent('menu-save-as', callback),
  onMenuDiscard: (callback: () => void): (() => void) => onMenuEvent('menu-discard', callback),
  onMenuApplyMuseScore: (callback: () => void): (() => void) =>
    onMenuEvent('menu-apply-musescore', callback)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
