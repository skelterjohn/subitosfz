import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getServerPort: (): Promise<number> => ipcRenderer.invoke('get-server-port'),
  getStartTime: (): Promise<number> => ipcRenderer.invoke('get-start-time'),
  chooseSf2File: (): Promise<string | null> => ipcRenderer.invoke('choose-sf2-file'),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('choose-directory'),
  chooseSfzFile: (): Promise<string | null> => ipcRenderer.invoke('choose-sfz-file')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
