import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getServerPort: (): Promise<number> => ipcRenderer.invoke('get-server-port'),
  getStartTime: (): Promise<number> => ipcRenderer.invoke('get-start-time')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
