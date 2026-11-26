import { useEffect, useRef, useState } from 'react'
import TopMenuBar from './components/TopMenuBar'
import InstrumentGrid from './components/InstrumentGrid'
import NewInstrumentModal from './components/NewInstrumentModal'
import ImportSf2Modal from './components/ImportSf2Modal'
import ImportRecordingModal from './components/ImportRecordingModal'
import AssignChunkModal from './components/AssignChunkModal'
import ApplyToMuseScoreModal from './components/ApplyToMuseScoreModal'
import AboutModal from './components/AboutModal'
import ChunkDrawer from './components/ChunkDrawer'
import SampleEditorPanel from './components/SampleEditorPanel'
import SampleTakeList from './components/SampleTakeList'
import {
  emptyInstrument,
  findCellByRegionIndex,
  findCellWithHighestRegionIndex,
  findMatchingCell,
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
  const [newInstrumentOpen, setNewInstrumentOpen] = useState(false)
  const [applyMuseScoreOpen, setApplyMuseScoreOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [sfzFilePath, setSfzFilePath] = useState<string | null>(null)
  const [instrument, setInstrument] = useState<Instrument>(() => emptyInstrument())
  const [sfzLoadError, setSfzLoadError] = useState<string | null>(null)
  const [selectedCell, setSelectedCell] = useState<CellRecord | null>(null)
  // Kept alive for the app's lifetime (not recreated per selection) so
  // clicking through many cells in a row doesn't pile up AudioContexts.
  const cellPreviewAudioCtxRef = useRef<AudioContext | null>(null)
  const [importRecordingOpen, setImportRecordingOpen] = useState(false)
  const [assigningChunk, setAssigningChunk] = useState<DrawerChunk | null>(null)
  const [drawerChunks, setDrawerChunks] = useState<DrawerChunk[]>([])
  // Lifted up from ChunkDrawer (rather than local state there) so a
  // completed import can force it open - see ImportRecordingModal's
  // onImported below.
  const [drawerOpen, setDrawerOpen] = useState(false)
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

  // Converts every region sharing a cell - which, with no lorand/hirand
  // set, all fire together on one note-on - into round-robin: each region
  // gets an equal slice of the 0..1 random range sfizz/ARIA-style engines
  // roll fresh on every trigger (region i gets [i/N, (i+1)/N), the last
  // one's hirand pinned to exactly "1" rather than a rounded fraction so
  // the very top of the range is never left unmatched), in the same
  // top-to-bottom/left-to-right order the take list already shows them
  // in. Random rather than seq_length/seq_position's strict cycling - see
  // the chat for why that's what's actually wanted here. Also pins
  // seq_length/seq_position to 1/1 (a no-op combination - a region always
  // matches its own single-slot cycle) on every region, in case an
  // earlier version of this feature already left round-robin opcodes on
  // them; leaving both schemes active at once would AND them together
  // instead of cleanly replacing one with the other.
  //
  // Deliberately per-REGION, not per-take: until lorand/hirand (or
  // seq_position/trigger) exists, sfz_parse.rs's sound_identity has no
  // way to tell a stereo pair's two mic channels apart from two distinct
  // round-robin recordings - same-criteria regions with no such opcode
  // just collapse into one take, however many of them there are. That's
  // exactly the state this button exists to break apart, so "the group"
  // has to mean every raw region currently in the cell, not however many
  // takes they happen to already be bucketed into - this will also split
  // apart a genuine same-cell stereo pair if one exists, since nothing in
  // the data distinguishes that case from this one (see the deferred
  // region-grouping note for the real fix). Re-running this always resets
  // to a clean, equally-sliced range in current order, so it's safe to
  // click again after adding another region.
  //
  // Does its own sequential backend writes instead of looping calls to
  // setCellOpcodes, so only the FINAL response drives a UI update/grid
  // remount - one remount per region would be visually noisy for no benefit.
  async function splitCellIntoRoundRobin(cell: CellRecord): Promise<void> {
    if (!workingPath) throw new Error('no instrument is open')
    const regions = cell.samples.flatMap((take) => take.regions)
    const total = regions.length
    if (total < 2) return
    const port = await window.api.getServerPort()
    let parsed: ParsedSfzResponse | null = null
    for (let i = 0; i < total; i++) {
      const lorand = i === 0 ? '0' : (i / total).toFixed(6)
      const hirand = i === total - 1 ? '1' : ((i + 1) / total).toFixed(6)
      const res = await fetch(`http://127.0.0.1:${port}/sfz/set-cell-opcodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingSfzPath: workingPath,
          regionIndices: [regions[i].regionIndex],
          opcodes: [
            { name: 'lorand', value: lorand },
            { name: 'hirand', value: hirand },
            { name: 'seq_length', value: '1' },
            { name: 'seq_position', value: '1' }
          ]
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      parsed = (await res.json()) as ParsedSfzResponse
    }
    if (!parsed) return
    const next = instrumentFromParsedSfz(parsed)
    setInstrument(next)
    setSelectedCell(findMatchingCell(next, cell))
    setDirty(true)
    setLoadGeneration((g) => g + 1)
  }

  // Removes one region's own <region> block entirely (not just an opcode
  // edit) - unlike every other mutation here, this is a delete, not an
  // append (see sfz_write.rs's delete_region). The sample file on disk is
  // untouched, so the drawer's own scan (a pure filesystem diff against the
  // instrument's current regions) picks it back up as unassigned on its
  // own, with no separate signal needed here.
  //
  // Always bumps loadGeneration (unlike setRegionOpcode's conditional
  // bump): removing a region can shrink or remove a whole cell/axis value,
  // exactly the kind of grouping change that needs the grid's pivot state
  // reset. regionIndex no longer identifies anything useful afterward (the
  // deleted one is gone, every later one shifted down), so the previously
  // selected cell is re-found by its own criteria instead - that keeps the
  // selection when only one take/region of several was removed, and
  // cleanly deselects if the whole cell is now gone.
  async function deleteRegion(regionIndex: number): Promise<void> {
    if (!workingPath) throw new Error('no instrument is open')
    const port = await window.api.getServerPort()
    const res = await fetch(`http://127.0.0.1:${port}/sfz/delete-region`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingSfzPath: workingPath, regionIndex })
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error ?? `request failed (${res.status})`)
    }
    const parsed = (await res.json()) as ParsedSfzResponse
    const next = instrumentFromParsedSfz(parsed)
    setInstrument(next)
    setSelectedCell((current) => (current ? findMatchingCell(next, current) : null))
    setDirty(true)
    setLoadGeneration((g) => g + 1)
  }

  // One-shot preview so clicking around the grid gives an immediate audible
  // sense of what's assigned where - a stereo pair's two regions are the
  // same take, so just the first region is enough for identification.
  async function playRandomSampleFromCell(cell: CellRecord): Promise<void> {
    if (!sfzFilePath || cell.samples.length === 0) return
    const take = cell.samples[Math.floor(Math.random() * cell.samples.length)]
    const region = take.regions[0]
    if (!region) return
    try {
      let ctx = cellPreviewAudioCtxRef.current
      if (!ctx) {
        ctx = new AudioContext()
        cellPreviewAudioCtxRef.current = ctx
      }
      const bytes = await window.api.readAudioFile(sfzFilePath, region.samplePath)
      const arrayBuffer = bytes.slice().buffer as ArrayBuffer
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
      ctx.resume()
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      source.start()
    } catch {
      // Preview is a nicety, not essential - selection itself must not fail.
    }
  }

  function selectCell(cell: CellRecord): void {
    setSelectedCell(cell)
    playRandomSampleFromCell(cell)
  }

  async function openSfzFile(): Promise<void> {
    const path = await window.api.chooseSfzFile()
    if (!path) return
    await loadSfzFile(path)
  }

  // Re-copies the real file over the working copy via loadSfzFile, throwing
  // away every edit made since the last Open/Save - the "undo everything"
  // escape hatch. Irreversible, so confirmed first, same as this app's
  // other destructive actions (delete-from-disk, delete-all, delete-region).
  // A no-op when there's nothing to discard.
  async function discardChanges(): Promise<void> {
    if (!sfzFilePath || !dirty) return
    if (!window.confirm('Discard all unsaved changes and reload from disk? This can\'t be undone.')) {
      return
    }
    await loadSfzFile(sfzFilePath)
  }

  // Gate in front of the New modal: creating a new instrument discards
  // whatever's currently open the same way Discard Changes does (loadSfzFile
  // replaces sfzFilePath/workingPath/instrument wholesale), so it needs the
  // same warning first if there's anything unsaved to lose. The modal itself
  // only handles picking a destination folder/name - this is just the
  // "is it safe to open the picker" check in front of it.
  function requestNewInstrument(): void {
    if (dirty && !window.confirm('Creating a new instrument will discard your unsaved changes. Continue?')) {
      return
    }
    setNewInstrumentOpen(true)
  }

  // Gate in front of the Apply-to-MuseScore modal: it's a no-op with
  // nothing open to apply. Unlike requestNewInstrument, a dirty working
  // copy isn't blocked here - the modal surfaces that as a non-blocking
  // inline warning instead, since applying doesn't discard anything, it
  // just risks embedding a stale (pre-edit) sfz path if the user proceeds
  // without saving first.
  function requestApplyToMuseScore(): void {
    if (!sfzFilePath) return
    setApplyMuseScoreOpen(true)
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
  // empty on every fresh launch - but only in the one "primary" window
  // (see main/index.ts's autoReopenWindowIds). A window opened via File >
  // New Window starts blank on purpose, so it's free to open a different
  // sfz without disturbing whatever the original window has open.
  useEffect(() => {
    if (!window.api) return
    window.api.shouldAutoReopen().then((should) => {
      if (!should) return
      window.api.getLastSfzFile().then((path) => {
        if (path) loadSfzFile(path)
      })
    })
  }, [])

  // Just the filename, not the full path - used both for TopMenuBar's own
  // centered display and the OS window title below. null (not '') when
  // nothing is open, so callers can tell "no file" apart from an empty name.
  const openFileName = sfzFilePath ? sfzFilePath.split(/[/\\]/).pop() ?? sfzFilePath : null

  // document.title drives the real OS window title - Electron mirrors it
  // automatically (no explicit win.setTitle needed) - which is what shows
  // up in the taskbar's hover tooltip, Alt+Tab, etc., so this is the one
  // place that needs the "$FILE - subito sfz" form specifically asked for
  // there. TopMenuBar's own on-bar text is just the bare filename instead
  // (see its openFileName prop) - the app identity is already given by the
  // icon right next to it.
  useEffect(() => {
    document.title = openFileName ? `${openFileName} - subito sfz` : 'subito sfz'
  }, [openFileName])

  // File menu (main/index.ts) just forwards clicks here - Open/Import/Save
  // reuse the exact same functions as their toolbar buttons. Save As still
  // doesn't do anything real: writing a working copy's content out under a
  // different path/directory would need to rewrite every region's relative
  // sample= path too, which is a separate, bigger feature than Save.
  //
  // Re-subscribes whenever sfzFilePath/workingPath/dirty change (i.e. on
  // every open or edit) rather than once on mount: an empty dependency
  // array here would freeze the onMenuSave callback's closure on whatever
  // saveSfzFile/discardChanges looked like at mount, when sfzFilePath was
  // still null and dirty still false - Save would silently no-op forever
  // after, since that captured closure's `if (!sfzFilePath...) return`
  // guard never sees a later open, and Discard Changes would never see a
  // later edit flip dirty to true.
  useEffect(() => {
    if (!window.api) return
    const offNew = window.api.onMenuNew(() => {
      requestNewInstrument()
    })
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
    const offDiscard = window.api.onMenuDiscard(() => {
      discardChanges()
    })
    const offApplyMuseScore = window.api.onMenuApplyMuseScore(() => {
      requestApplyToMuseScore()
    })
    const offAbout = window.api.onMenuAbout(() => setAboutOpen(true))
    return () => {
      offNew()
      offImport()
      offImportRecording()
      offOpen()
      offSave()
      offSaveAs()
      offDiscard()
      offAbout()
      offApplyMuseScore()
    }
  }, [sfzFilePath, workingPath, dirty])

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
  // the change without discarding any other not-yet-saved edits). Selects
  // whichever cell the newly appended region landed in (new or existing),
  // so the sample panel shows it immediately instead of going blank.
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
      const next = instrumentFromParsedSfz(parsed)
      setInstrument(next)
      setSelectedCell(findCellWithHighestRegionIndex(next))
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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif' }}>
      {/* No-op (renders null) on macOS, which keeps its File menu in the
          native system menu bar - see TopMenuBar.tsx. Lives outside the
          padded content div below, so fontFamily is set on this shared
          outer wrapper instead - otherwise TopMenuBar would fall back to
          the browser default font instead of matching the rest of the app. */}
      <TopMenuBar
        openFileName={openFileName}
        fileActions={{
          onNewWindow: () => window.api.newWindow(),
          onNew: requestNewInstrument,
          onImportSf2: () => setImportOpen(true),
          onImportAudio: () => setImportRecordingOpen(true),
          onOpen: openSfzFile,
          onSave: saveSfzFile,
          onSaveAs: () => console.log('[menu] save as requested - not implemented yet'),
          onDiscardChanges: discardChanges,
          onApplyToMuseScore: requestApplyToMuseScore
        }}
        helpActions={{
          onGitHubRepo: () => window.api.openGitHubRepo(),
          onGitHubIssues: () => window.api.openGitHubIssues(),
          onAbout: () => setAboutOpen(true)
        }}
      />
      <div
        style={{
          padding: '1.25rem',
          flex: '1 1 0',
          minHeight: 0,
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

      {newInstrumentOpen && (
        <NewInstrumentModal
          onClose={() => setNewInstrumentOpen(false)}
          onCreated={(path) => loadSfzFile(path)}
        />
      )}
      {importOpen && <ImportSf2Modal onClose={() => setImportOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {importRecordingOpen && (
        <ImportRecordingModal
          sfzFilePath={sfzFilePath}
          onClose={() => setImportRecordingOpen(false)}
          onImported={() => {
            setDrawerRefreshNonce((n) => n + 1)
            setDrawerOpen(true)
            setImportRecordingOpen(false)
          }}
        />
      )}
      {applyMuseScoreOpen && sfzFilePath && (
        <ApplyToMuseScoreModal
          sfzFilePath={sfzFilePath}
          dirty={dirty}
          existingArticulations={instrument.articulationAxis}
          onClose={() => setApplyMuseScoreOpen(false)}
        />
      )}
      {assigningChunk && sfzFilePath && workingPath && (
        <AssignChunkModal
          chunk={assigningChunk}
          sfzFilePath={sfzFilePath}
          workingSfzPath={workingPath}
          existingArticulations={instrument.articulationAxis}
          cells={instrument.cells}
          selectedCell={selectedCell}
          onClose={() => setAssigningChunk(null)}
          onAssigned={reparseWorkingCopy}
        />
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flex: 1, minHeight: 0 }}>
        <InstrumentGrid
          key={loadGeneration}
          instrument={instrument}
          fileOpen={sfzFilePath !== null}
          selectedCell={selectedCell}
          onSelectCell={selectCell}
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
              onDeleteRegion={deleteRegion}
              onSplitRoundRobin={() =>
                selectedCell ? splitCellIntoRoundRobin(selectedCell) : Promise.resolve()
              }
            />
          </div>
          {/* Absolutely positioned against this column (position: relative
              above) - closed, it sits off its right edge; opened, it slides
              in and occludes the sample panel rather than sharing space with
              it as a permanent third column. */}
          <ChunkDrawer
            chunks={drawerChunks}
            sfzFilePath={sfzFilePath}
            open={drawerOpen}
            onToggle={() => setDrawerOpen((v) => !v)}
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
    </div>
  )
}
