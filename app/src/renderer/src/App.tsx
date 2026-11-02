import { useEffect, useState } from 'react'
import InstrumentGrid from './components/InstrumentGrid'
import ImportSf2Modal from './components/ImportSf2Modal'
import SampleEditorPanel from './components/SampleEditorPanel'
import SampleTakeList from './components/SampleTakeList'
import {
  emptyInstrument,
  instrumentFromParsedSfz,
  type CellRecord,
  type Instrument,
  type ParsedSfzResponse
} from './model/instrument'

interface HealthResponse {
  status: string
  version: string
}

export default function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startupMs, setStartupMs] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [sfzFilePath, setSfzFilePath] = useState<string | null>(null)
  const [instrument, setInstrument] = useState<Instrument>(() => emptyInstrument())
  const [sfzLoadError, setSfzLoadError] = useState<string | null>(null)
  const [selectedCell, setSelectedCell] = useState<CellRecord | null>(null)
  // Forces InstrumentGrid to remount only once a freshly-parsed instrument
  // is actually ready, rather than keying off sfzFilePath directly - that
  // would remount (and lazily re-init the grid's cell state) the moment the
  // path is set, before the async parse resolves, locking the grid's cells
  // onto whatever instrument was current at that premature mount.
  const [loadGeneration, setLoadGeneration] = useState(0)

  // Shared by the "open" button and the startup auto-reload - only the
  // source of the path differs between them.
  async function loadSfzFile(path: string): Promise<void> {
    setSfzFilePath(path)
    setSfzLoadError(null)

    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/sfz/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const parsed = (await res.json()) as ParsedSfzResponse
      setInstrument(instrumentFromParsedSfz(parsed))
      setSelectedCell(null)
      setLoadGeneration((g) => g + 1)
      // Only cache on success - caching a path that fails to parse would
      // just repeat the same failure on every future startup.
      window.api.setLastSfzFile(path)
    } catch (err) {
      setSfzLoadError(String(err))
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

  // File menu (main/index.ts) just forwards clicks here - Open/Import reuse
  // the exact same functions as their toolbar buttons. Save/Save As don't do
  // anything real yet: there's no .sfz serializer in this app at all, so
  // wiring them to a fake success would be worse than a visible stub.
  useEffect(() => {
    if (!window.api) return
    const offImport = window.api.onMenuImport(() => setImportOpen(true))
    const offOpen = window.api.onMenuOpen(() => {
      openSfzFile()
    })
    const offSave = window.api.onMenuSave(() => {
      console.log('[menu] save requested - not implemented yet (no .sfz serializer)')
    })
    const offSaveAs = window.api.onMenuSaveAs(() => {
      console.log('[menu] save as requested - not implemented yet (no .sfz serializer)')
    })
    return () => {
      offImport()
      offOpen()
      offSave()
      offSaveAs()
    }
  }, [])

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
          <span className="title-bar__sfz-path">{sfzFilePath}</span>
          {sfzLoadError && (
            <span className="title-bar__sfz-error">failed to load: {sfzLoadError}</span>
          )}
        </div>
      )}

      {importOpen && <ImportSf2Modal onClose={() => setImportOpen(false)} />}

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
            gap: '0.75rem'
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
            <SampleEditorPanel cell={selectedCell} />
            <SampleTakeList cell={selectedCell} sfzFilePath={sfzFilePath} />
          </div>
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
