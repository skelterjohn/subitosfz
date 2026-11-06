import { useEffect, useState } from 'react'
import InstrumentGrid from './components/InstrumentGrid'
import ImportSf2Modal from './components/ImportSf2Modal'
import ImportRecordingModal from './components/ImportRecordingModal'
import AssignChunkModal from './components/AssignChunkModal'
import ChunkDrawer from './components/ChunkDrawer'
import SampleEditorPanel from './components/SampleEditorPanel'
import SampleTakeList from './components/SampleTakeList'
import {
  emptyInstrument,
  findCellByRegionIndex,
  instrumentFromParsedSfz,
  type CellRecord,
  type Instrument,
  type ParsedSfzResponse
} from './model/instrument'
import { unassignedChunks, type DrawerChunk } from './model/drawer'

interface HealthResponse {
  status: string
  version: string
}

// Opcodes that can change which cell/take a region belongs to (the cell
// key, sound_identity, or note-derivation fields in sfz_parse.rs) - editing
// any of these needs a full InstrumentGrid remount since the overall axis
// ranges themselves could shift, not just this one cell. Everything else
// (pan, tune, envelope...) updates `instrument` in place instead, avoiding
// a pivot-view flicker on every single-value edit.
const CELL_AFFECTING_OPCODES = new Set([
  'lokey',
  'hikey',
  'lovel',
  'hivel',
  'key',
  'pitch_keycenter',
  'sw_last',
  'seq_position',
  'lorand',
  'hirand',
  'trigger'
])

export default function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startupMs, setStartupMs] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [sfzFilePath, setSfzFilePath] = useState<string | null>(null)
  const [instrument, setInstrument] = useState<Instrument>(() => emptyInstrument())
  const [sfzLoadError, setSfzLoadError] = useState<string | null>(null)
  const [selectedCell, setSelectedCell] = useState<CellRecord | null>(null)
  const [importRecordingOpen, setImportRecordingOpen] = useState(false)
  const [assigningChunk, setAssigningChunk] = useState<DrawerChunk | null>(null)
  const [drawerChunks, setDrawerChunks] = useState<DrawerChunk[]>([])
  // Bumped after a chunk-import that doesn't touch the .sfz at all, so the
  // drawer rescan effect below has a reason to re-run even though neither
  // `instrument` nor `sfzFilePath` changed.
  const [drawerRefreshNonce, setDrawerRefreshNonce] = useState(0)
  // Forces InstrumentGrid to remount only once a freshly-parsed instrument
  // is actually ready, rather than keying off sfzFilePath directly - that
  // would remount (and lazily re-init the grid's cell state) the moment the
  // path is set, before the async parse resolves, locking the grid's cells
  // onto whatever instrument was current at that premature mount.
  const [loadGeneration, setLoadGeneration] = useState(0)
  // Where edits actually land - an app-specific temp path computed by the
  // main process (see get-working-sfz-path in main/index.ts), never next
  // to the real file. Resolved fresh by loadSfzFile below; null whenever
  // sfzFilePath is, so "no file open" and "no working copy yet" can't
  // drift out of sync.
  const [workingPath, setWorkingPath] = useState<string | null>(null)
  // True once the working copy has diverged from the real file - set on
  // every successful edit, cleared on open (fresh copy, nothing to diverge
  // yet) and on save (the two are back in sync). Purely a display concern
  // (the title-bar asterisk below); doesn't gate anything.
  const [dirty, setDirty] = useState(false)

  // Shared by the "open" button and the startup auto-reload - only the
  // source of the path differs between them. Copies the real file into a
  // fresh working copy and parses THAT, so sfzFilePath itself is never
  // touched by anything other than this function and saveSfzFile below.
  async function loadSfzFile(path: string): Promise<void> {
    setSfzFilePath(path)
    setSfzLoadError(null)

    try {
      const working = await window.api.getWorkingSfzPath(path)
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/sfz/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originalPath: path, workingPath: working })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const parsed = (await res.json()) as ParsedSfzResponse
      setWorkingPath(working)
      setInstrument(instrumentFromParsedSfz(parsed))
      setSelectedCell(null)
      setLoadGeneration((g) => g + 1)
      setDirty(false)
      // Only cache on success - caching a path that fails to parse would
      // just repeat the same failure on every future startup.
      window.api.setLastSfzFile(path)
    } catch (err) {
      setSfzLoadError(String(err))
    }
  }

  // The only place anywhere in this app that writes to the file the user
  // actually opened - everything else (adding/editing opcodes, assigning
  // drawer samples) only ever touches the working copy.
  async function saveSfzFile(): Promise<void> {
    if (!sfzFilePath || !workingPath) return
    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/sfz/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingPath, originalPath: sfzFilePath })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      setDirty(false)
    } catch (err) {
      window.alert(`Failed to save: ${String(err)}`)
    }
  }

  // Edits and adds are the same backend operation - see sfz_write.rs. On
  // success, re-finds and re-selects whichever cell now contains the
  // edited region (by its stable regionIndex), so the sample being worked
  // on stays visible even if the edit moved it to a different cell.
  // Rethrows on failure so the calling row can show its own inline error.
  async function setRegionOpcode(regionIndex: number, name: string, value: string): Promise<void> {
    if (!workingPath || !sfzFilePath) throw new Error('no instrument is open')
    const port = await window.api.getServerPort()
    const res = await fetch(`http://127.0.0.1:${port}/sfz/set-opcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workingSfzPath: workingPath,
        originalSfzPath: sfzFilePath,
        regionIndex,
        name,
        value
      })
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error ?? `request failed (${res.status})`)
    }
    const parsed = (await res.json()) as ParsedSfzResponse
    const next = instrumentFromParsedSfz(parsed)
    setInstrument(next)
    setSelectedCell(findCellByRegionIndex(next, regionIndex))
    setDirty(true)
    if (CELL_AFFECTING_OPCODES.has(name)) {
      setLoadGeneration((g) => g + 1)
    }
  }

  // Same shape as setRegionOpcode, but fans the same set of opcodes out to
  // every region in `regionIndices` in one backend call - used for editing
  // a cell's own criteria (pitch, pitch range, volume, articulation) from
  // SampleEditorPanel, where "the cell" really means every region across
  // every take that currently shares those criteria, and an edit should
  // move all of them together rather than splitting the group apart.
  // Reselects by the FIRST region index, since a successful batch edit
  // puts all of them back in the same cell together.
  async function setCellOpcodes(
    regionIndices: number[],
    opcodes: Array<{ name: string; value: string }>
  ): Promise<void> {
    if (!workingPath) throw new Error('no instrument is open')
    if (regionIndices.length === 0) return
    const port = await window.api.getServerPort()
    const res = await fetch(`http://127.0.0.1:${port}/sfz/set-cell-opcodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingSfzPath: workingPath, regionIndices, opcodes })
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error ?? `request failed (${res.status})`)
    }
    const parsed = (await res.json()) as ParsedSfzResponse
    const next = instrumentFromParsedSfz(parsed)
    setInstrument(next)
    setSelectedCell(findCellByRegionIndex(next, regionIndices[0]))
    setDirty(true)
    if (opcodes.some((op) => CELL_AFFECTING_OPCODES.has(op.name))) {
      setLoadGeneration((g) => g + 1)
    }
  }

  async function openSfzFile(): Promise<void> {
    const path = await window.api.chooseSfzFile()
    if (!path) return
    await loadSfzFile(path)
  }

  // Measured on first render of this screen, independent of sidecar status,
  // so it always reports how long launch took to reach visible UI.
  useEffect(() => {
    if (!window.api) {
      setError('preload bridge (window.api) is not available')
      return
    }
    window.api.getStartTime().then((startTime) => {
      setStartupMs(Math.round(Date.now() - startTime))
    })
  }, [])

  // Reopen whatever .sfz was last successfully loaded, so the grid isn't
  // empty on every fresh launch.
  useEffect(() => {
    if (!window.api) return
    window.api.getLastSfzFile().then((path) => {
      if (path) loadSfzFile(path)
    })
  }, [])

  // File menu (main/index.ts) just forwards clicks here - Open/Import/Save
  // reuse the exact same functions as their toolbar buttons. Save As still
  // doesn't do anything real: writing a working copy's content out under a
  // different path/directory would need to rewrite every region's relative
  // sample= path too, which is a separate, bigger feature than Save.
  //
  // Re-subscribes whenever sfzFilePath/workingPath change (i.e. on every
  // open - edits don't touch either) rather than once on mount: an empty
  // dependency array here would freeze the onMenuSave callback's closure
  // on whatever saveSfzFile looked like at mount, when both paths were
  // still null - Save would silently no-op forever after, since that
  // captured closure's `if (!sfzFilePath || !workingPath) return` guard
  // never sees a later open.
  useEffect(() => {
    if (!window.api) return
    const offImport = window.api.onMenuImport(() => setImportOpen(true))
    const offImportRecording = window.api.onMenuImportRecording(() => setImportRecordingOpen(true))
    const offOpen = window.api.onMenuOpen(() => {
      openSfzFile()
    })
    const offSave = window.api.onMenuSave(() => {
      saveSfzFile()
    })
    const offSaveAs = window.api.onMenuSaveAs(() => {
      console.log('[menu] save as requested - not implemented yet')
    })
    return () => {
      offImport()
      offImportRecording()
      offOpen()
      offSave()
      offSaveAs()
    }
  }, [sfzFilePath, workingPath])

  // The drawer is a pure filesystem diff (unassigned .wav files in the
  // project directory) - recomputed whenever the instrument changes (a
  // region got added, or a different file was opened) or when a chunk
  // import wrote new files without touching the .sfz at all (the
  // drawerRefreshNonce bump is the only signal for that case).
  useEffect(() => {
    if (!window.api || !sfzFilePath) {
      setDrawerChunks([])
      return
    }
    let cancelled = false
    // The PROJECT directory (where actual sample files live), not the
    // working copy's temp directory - listDirectory just derives dirname
    // from whatever path it's given.
    window.api.listDirectory(sfzFilePath).then((names) => {
      if (!cancelled) setDrawerChunks(unassignedChunks(instrument, names))
    })
    return () => {
      cancelled = true
    }
  }, [instrument, sfzFilePath, drawerRefreshNonce])

  // Re-parses the working copy in place (no fresh copy from the original,
  // unlike loadSfzFile - used after a mutation that already landed on the
  // working copy itself, like assigning a drawer sample, so it picks up
  // the change without discarding any other not-yet-saved edits).
  async function reparseWorkingCopy(): Promise<void> {
    if (!workingPath) return
    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/sfz/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: workingPath })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const parsed = (await res.json()) as ParsedSfzResponse
      setInstrument(instrumentFromParsedSfz(parsed))
      setSelectedCell(null)
      setLoadGeneration((g) => g + 1)
      setDirty(true)
    } catch (err) {
      setSfzLoadError(String(err))
    }
  }

  useEffect(() => {
    if (!window.api) return
    let cancelled = false

    async function check(): Promise<void> {
      try {
        const port = await window.api.getServerPort()
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        const data = (await res.json()) as HealthResponse
        if (!cancelled) setHealth(data)
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    }

    check()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      style={{
        fontFamily: 'sans-serif',
        padding: '1.25rem',
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem'
      }}
    >
      {sfzFilePath && (
        <div className="open-row">
          <span className="title-bar__sfz-path">
            {sfzFilePath}
            {dirty && '*'}
          </span>
          {sfzLoadError && (
            <span className="title-bar__sfz-error">failed to load: {sfzLoadError}</span>
          )}
        </div>
      )}

      {importOpen && <ImportSf2Modal onClose={() => setImportOpen(false)} />}
      {importRecordingOpen && (
        <ImportRecordingModal
          sfzFilePath={sfzFilePath}
          onClose={() => setImportRecordingOpen(false)}
          onImported={() => setDrawerRefreshNonce((n) => n + 1)}
        />
      )}
      {assigningChunk && sfzFilePath && workingPath && (
        <AssignChunkModal
          chunk={assigningChunk}
          sfzFilePath={sfzFilePath}
          workingSfzPath={workingPath}
          existingArticulations={instrument.articulationAxis}
          onClose={() => setAssigningChunk(null)}
          onAssigned={reparseWorkingCopy}
        />
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flex: 1, minHeight: 0 }}>
        <InstrumentGrid
          key={loadGeneration}
          instrument={instrument}
          selectedCell={selectedCell}
          onSelectCell={setSelectedCell}
        />
        <div
          style={{
            flex: '1 1 0',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            position: 'relative'
          }}
        >
          {/* Matches InstrumentGrid's own toolbar row in height (same class,
              hidden) purely so the bordered boxes below - grid scroll area
              vs. sample editor - start at the same y, with no pivot control
              of its own to put there. */}
          <div className="instrument-grid__toolbar" style={{ visibility: 'hidden' }}>
            <span className="instrument-grid__pivot-label">placeholder</span>
          </div>
          <div className="sample-panel">
            <SampleEditorPanel
              cell={selectedCell}
              existingArticulations={instrument.articulationAxis}
              onSetCellOpcodes={setCellOpcodes}
            />
            <SampleTakeList
              cell={selectedCell}
              sfzFilePath={sfzFilePath}
              onSetOpcode={setRegionOpcode}
            />
          </div>
          {/* Absolutely positioned against this column (position: relative
              above) - closed, it sits off its right edge; opened, it slides
              in and occludes the sample panel rather than sharing space with
              it as a permanent third column. */}
          <ChunkDrawer
            chunks={drawerChunks}
            sfzFilePath={sfzFilePath}
            onAssign={setAssigningChunk}
            onDeleted={() => setDrawerRefreshNonce((n) => n + 1)}
          />
        </div>
      </div>

      <div style={{ color: '#888', fontSize: '0.75rem', borderTop: '1px solid #eee', paddingTop: '0.4rem' }}>
        {startupMs === null ? 'Measuring startup time…' : `Ready in ${startupMs}ms`}
        {' · '}
        {error && <span style={{ color: 'crimson' }}>Sidecar error: {error}</span>}
        {!error && !health && 'Connecting to local server…'}
        {health && (
          <>
            Server status: <strong>{health.status}</strong> (v{health.version})
          </>
        )}
      </div>
    </div>
  )
}
