import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { readFileSync, writeFileSync } from 'node:fs'
import windowStateKeeper from 'electron-window-state'

// performance.timeOrigin is the epoch time the Node/Electron process itself
// started, which is earlier (and more honest) than Date.now() taken here.
const appStartTime = performance.timeOrigin

let serverProcess: ChildProcess | null = null
let serverPort: number | null = null
let mainWindow: BrowserWindow | null = null

interface ImportDirs {
  lastSf2Dir?: string
  lastDestDir?: string
  lastSfzDir?: string
}

function importDirsPath(): string {
  return join(app.getPath('userData'), 'import-dirs.json')
}

function loadImportDirs(): ImportDirs {
  try {
    return JSON.parse(readFileSync(importDirsPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function saveImportDirs(dirs: ImportDirs): void {
  try {
    writeFileSync(importDirsPath(), JSON.stringify(dirs))
  } catch (err) {
    console.error('[main] failed to save import-dirs.json:', err)
  }
}

function sidecarBinaryPath(): string {
  const binName = process.platform === 'win32' ? 'subitosfz-server.exe' : 'subitosfz-server'
  if (app.isPackaged) {
    return join(process.resourcesPath, 'server', binName)
  }
  // Dev: main process output lives at app/out/main, the sidecar is a sibling
  // repo folder built with `cargo build` inside server/.
  return join(__dirname, '../../../server/target/debug', binName)
}

function startSidecar(): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(sidecarBinaryPath(), [], { stdio: ['ignore', 'pipe', 'pipe'] })
    serverProcess = proc

    proc.stdout.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/SUBITOSFZ_SERVER_PORT=(\d+)/)
      if (match) resolve(Number(match[1]))
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      console.error(`[sidecar] ${chunk.toString().trim()}`)
    })

    proc.on('error', reject)
    proc.on('exit', (code) => {
      console.log(`[sidecar] exited with code ${code}`)
      serverProcess = null
    })
  })
}

async function createWindow(): Promise<void> {
  // Persists/restores window position+size (and maximized state) across
  // launches, in a JSON file under app.getPath('userData').
  const windowState = windowStateKeeper({
    defaultWidth: 1000,
    defaultHeight: 700
  })

  const win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  windowState.manage(win)
  mainWindow = win

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)

  ipcMain.handle('get-server-port', () => serverPort)
  ipcMain.handle('get-start-time', () => appStartTime)

  ipcMain.handle('choose-sf2-file', async () => {
    if (!mainWindow) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a SoundFont',
      defaultPath: dirs.lastSf2Dir,
      properties: ['openFile'],
      filters: [{ name: 'SoundFont', extensions: ['sf2', 'sf3'] }]
    })
    if (result.canceled) return null
    const filePath = result.filePaths[0]
    saveImportDirs({ ...dirs, lastSf2Dir: dirname(filePath) })
    return filePath
  })

  ipcMain.handle('choose-sfz-file', async () => {
    if (!mainWindow) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open an SFZ file',
      defaultPath: dirs.lastSfzDir,
      properties: ['openFile'],
      filters: [{ name: 'SFZ', extensions: ['sfz'] }]
    })
    if (result.canceled) return null
    const filePath = result.filePaths[0]
    saveImportDirs({ ...dirs, lastSfzDir: dirname(filePath) })
    return filePath
  })

  ipcMain.handle('choose-directory', async () => {
    if (!mainWindow) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a destination folder',
      defaultPath: dirs.lastDestDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return null
    const dirPath = result.filePaths[0]
    saveImportDirs({ ...dirs, lastDestDir: dirPath })
    return dirPath
  })

  serverPort = await startSidecar()
  console.log(`[main] sidecar listening on port ${serverPort}`)

  // Startup self-check: fail loudly in the terminal if the sidecar didn't
  // actually come up healthy, rather than leaving the renderer to guess.
  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/health`)
    const body = await res.json()
    console.log('[main] sidecar health check:', body)
  } catch (err) {
    console.error('[main] sidecar health check failed:', err)
  }

  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  serverProcess?.kill()
})
