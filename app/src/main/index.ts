import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { basename, dirname, join, relative } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, unlink } from 'node:fs/promises'
import windowStateKeeper from 'electron-window-state'

// performance.timeOrigin is the epoch time the Node/Electron process itself
// started, which is earlier (and more honest) than Date.now() taken here.
const appStartTime = performance.timeOrigin

let serverProcess: ChildProcess | null = null
let serverPort: number | null = null

// Windows opened via File > New Window start blank (see App.tsx's startup
// effect, gated on should-auto-reopen below) - only the one true "primary"
// window (app launch, or macOS's 'activate' recreating one when none are
// left) auto-reopens the last session's sfz. Tracked by window id since
// there's no longer a single global "the window" once more than one can
// exist at a time.
const autoReopenWindowIds = new Set<number>()
let secondaryWindowCascade = 0

// Menu click handlers and dialogs need *a* window to target. For the
// former (the one static Menu, shared by every window), that's whichever
// window currently has focus; for the latter (an ipcMain.handle call),
// it's always resolved via BrowserWindow.fromWebContents(event.sender)
// instead - the window that actually asked, not "whichever has focus",
// since the two aren't necessarily the same by the time an async dialog
// result comes back.
function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

// Must match TopMenuBar.css's `.top-menu-bar` height exactly - this is the
// window's native titleBarOverlay caption-button strip (Windows only), the
// CSS value is our own drawn bar directly beneath/behind it. A mismatch
// means the native minimize/maximize/close buttons float over two rows
// instead of lining up with our single one.
const TOP_BAR_HEIGHT = 32

interface ImportDirs {
  lastSf2Dir?: string
  lastDestDir?: string
  lastSfzDir?: string
  lastRecordingDir?: string
  lastMuseScoreDir?: string
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

interface LastSession {
  sfzFilePath?: string
  pivotAxis?: string
  pivotValue?: string
}

function lastSessionPath(): string {
  return join(app.getPath('userData'), 'last-session.json')
}

function loadLastSession(): LastSession {
  try {
    return JSON.parse(readFileSync(lastSessionPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function saveLastSession(session: LastSession): void {
  try {
    writeFileSync(lastSessionPath(), JSON.stringify(session))
  } catch (err) {
    console.error('[main] failed to save last-session.json:', err)
  }
}

function appIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'icon.png')
  }
  // Dev: main process output lives at app/out/main, resources/ is a sibling
  // of src/ at the app root.
  return join(__dirname, '../../resources/icon.png')
}

// Every edit in the app targets this working copy, never the file the
// user actually opened - an app-specific temp directory, not next to the
// real file, so it never shows up alongside the user's own files. Hashed
// (not just the basename) so two different projects that happen to share
// a filename never collide; the directory is created up front since
// Rust's fs::copy (which writes the working copy itself) doesn't create
// parent directories for its destination.
function workingSfzPath(originalPath: string): string {
  const dir = join(app.getPath('temp'), 'subitosfz')
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha1').update(originalPath).digest('hex').slice(0, 12)
  return join(dir, `${hash}-${basename(originalPath)}`)
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

// Click handlers just forward to the renderer, which already owns the
// actual open/import logic (and, eventually, save) - the menu is just
// another entry point into it, not a second implementation.
function buildMenu(): Menu {
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'New Window',
        accelerator: 'CmdOrCtrl+Shift+N',
        // Unlike every other item here, this doesn't forward to the
        // renderer at all - opening a window is main-process-only, and
        // there's no existing window to ask (the new one is the point).
        click: () => {
          createWindow(false)
        }
      },
      { type: 'separator' },
      {
        label: 'New…',
        accelerator: 'CmdOrCtrl+N',
        click: () => focusedWindow()?.webContents.send('menu-new')
      },
      {
        label: 'Import SF2/SF3…',
        click: () => focusedWindow()?.webContents.send('menu-import')
      },
      {
        label: 'Import Audio…',
        click: () => focusedWindow()?.webContents.send('menu-import-recording')
      },
      {
        label: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        click: () => focusedWindow()?.webContents.send('menu-open')
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: () => focusedWindow()?.webContents.send('menu-save')
      },
      {
        label: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => focusedWindow()?.webContents.send('menu-save-as')
      },
      {
        label: 'Discard Changes',
        click: () => focusedWindow()?.webContents.send('menu-discard')
      },
      { type: 'separator' },
      {
        label: 'Apply to MuseScore…',
        click: () => focusedWindow()?.webContents.send('menu-apply-musescore')
      },
      { type: 'separator' },
      { role: 'quit', accelerator: 'CmdOrCtrl+Q' }
    ]
  }
  return Menu.buildFromTemplate([fileMenu])
}

async function createWindow(autoReopen: boolean): Promise<void> {
  // Only the one true "primary" window (app launch, or macOS's 'activate'
  // recreating one when none are left) persists/restores its position and
  // size across launches (electron-window-state's JSON file under
  // app.getPath('userData') has no per-window identity, so sharing it
  // across several open windows would just make them fight over the same
  // saved state). A window opened via File > New Window skips that
  // entirely and starts at a small cascading offset instead, so repeated
  // New Windows don't stack exactly on top of each other or of the
  // primary window.
  const windowState = autoReopen ? windowStateKeeper({ defaultWidth: 1000, defaultHeight: 700 }) : null
  const cascade = autoReopen ? 0 : ++secondaryWindowCascade * 32

  const win = new BrowserWindow({
    x: windowState ? windowState.x : 80 + cascade,
    y: windowState ? windowState.y : 80 + cascade,
    width: windowState?.width ?? 1000,
    height: windowState?.height ?? 700,
    icon: nativeImage.createFromPath(appIconPath()),
    // On Windows, TopMenuBar.tsx itself IS the title bar - no native frame
    // at all above it. titleBarStyle 'hidden' removes both the OS title
    // bar AND the classic File/Edit row; titleBarOverlay keeps Windows'
    // own minimize/maximize/close buttons drawn natively (pixel-perfect,
    // free hit-testing) layered on top of our content in that corner,
    // while we draw everything else (icon/title, File menu) ourselves.
    // TOP_BAR_HEIGHT must match TopMenuBar.css's own height so the native
    // buttons line up with our bar instead of floating over two rows.
    // macOS keeps its real native frame + system menu bar (unaffected by
    // any of this - see Menu.setApplicationMenu below). Linux keeps its
    // native frame too for now (titleBarOverlay isn't reliably supported
    // across desktop environments there) - just the classic menu row gets
    // hidden on Linux, same as before.
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#f3f3f3',
            symbolColor: '#333333',
            height: TOP_BAR_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  windowState?.manage(win)
  if (autoReopen) {
    const winId = win.id
    autoReopenWindowIds.add(winId)
    win.on('closed', () => autoReopenWindowIds.delete(winId))
  }

  // Linux fallback: no titleBarOverlay, so the native frame stays, but the
  // classic File/Edit row is still redundant with TopMenuBar.tsx - hide it.
  // Windows already has no menu row at all once titleBarStyle is 'hidden'.
  // macOS's application menu lives in the system menu bar, untouched here.
  if (process.platform === 'linux') {
    win.setMenuBarVisibility(false)
  }

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu())

  // Only reachable from TopMenuBar.tsx's own Quit item - the native menu's
  // own Quit (role: 'quit') doesn't need this, Electron handles that role
  // without any IPC round trip.
  ipcMain.handle('quit-app', () => app.quit())

  // Same story as Quit above - TopMenuBar.tsx's own "New Window" item has
  // to ask main to do this (a renderer can't create a BrowserWindow
  // itself); the native menu's equivalent item calls createWindow directly
  // since it's already running in the main process.
  ipcMain.handle('new-window', () => {
    createWindow(false)
  })

  // Asked once by App.tsx's startup effect to decide whether to auto-load
  // the last session's sfz - true only for the one window that was
  // launched as "primary" (see autoReopenWindowIds above), never for one
  // opened via New Window.
  ipcMain.handle('should-auto-reopen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? autoReopenWindowIds.has(win.id) : false
  })

  ipcMain.handle('get-server-port', () => serverPort)
  ipcMain.handle('get-start-time', () => appStartTime)
  ipcMain.handle('get-working-sfz-path', (_event, originalPath: string) => workingSfzPath(originalPath))

  ipcMain.handle('choose-sf2-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(win, {
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

  ipcMain.handle('choose-sfz-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(win, {
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

  ipcMain.handle('get-last-sfz-file', () => loadLastSession().sfzFilePath ?? null)

  ipcMain.handle('set-last-sfz-file', (_event, filePath: string | null) => {
    saveLastSession({ ...loadLastSession(), sfzFilePath: filePath ?? undefined })
  })

  ipcMain.handle('get-last-pivot', () => {
    const { pivotAxis, pivotValue } = loadLastSession()
    if (!pivotAxis || pivotValue === undefined) return null
    return { axis: pivotAxis, value: pivotValue }
  })

  ipcMain.handle('set-last-pivot', (_event, axis: string, value: string) => {
    saveLastSession({ ...loadLastSession(), pivotAxis: axis, pivotValue: value })
  })

  ipcMain.handle('read-audio-file', async (_event, sfzFilePath: string, relativeSamplePath: string) => {
    const fullPath = join(dirname(sfzFilePath), relativeSamplePath)
    const data = await readFile(fullPath)
    return new Uint8Array(data)
  })

  ipcMain.handle('list-directory', async (_event, sfzFilePath: string) => {
    const dirPath = dirname(sfzFilePath)
    // Recursive - long-take chunks now live in a per-import subdirectory
    // (see chunk.rs), and the drawer's unassigned-chunk diff needs to see
    // .wav files at any depth under the project root, not just top-level.
    const entries = await readdir(dirPath, { withFileTypes: true, recursive: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dirPath, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
  })

  ipcMain.handle('choose-audio-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose an audio file',
      defaultPath: dirs.lastRecordingDir,
      properties: ['openFile'],
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    })
    if (result.canceled) return null
    const filePath = result.filePaths[0]
    saveImportDirs({ ...dirs, lastRecordingDir: dirname(filePath) })
    return filePath
  })

  ipcMain.handle('delete-sample-file', async (_event, sfzFilePath: string, relativeSamplePath: string) => {
    const fullPath = join(dirname(sfzFilePath), relativeSamplePath)
    await unlink(fullPath)
  })

  ipcMain.handle('choose-musescore-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a MuseScore file',
      defaultPath: dirs.lastMuseScoreDir,
      properties: ['openFile'],
      filters: [{ name: 'MuseScore', extensions: ['mscz'] }]
    })
    if (result.canceled) return null
    const filePath = result.filePaths[0]
    saveImportDirs({ ...dirs, lastMuseScoreDir: dirname(filePath) })
    return filePath
  })

  ipcMain.handle('choose-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const dirs = loadImportDirs()
    const result = await dialog.showOpenDialog(win, {
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

  await createWindow(true)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(true)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  serverProcess?.kill()
})
