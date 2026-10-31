import { useEffect, useState } from 'react'
import InstrumentGrid from './components/InstrumentGrid'
import ImportSf2Modal from './components/ImportSf2Modal'

interface HealthResponse {
  status: string
  version: string
}

export default function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startupMs, setStartupMs] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)

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
      <div className="title-bar">
        <h1 style={{ margin: 0 }}>subito sfz</h1>
        <div className="title-bar__actions">
          <button type="button" className="title-bar__import" onClick={() => setImportOpen(true)}>
            import sf2/sf3
          </button>
          <button
            type="button"
            className="title-bar__close"
            onClick={() => window.close()}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      {importOpen && <ImportSf2Modal onClose={() => setImportOpen(false)} />}

      <InstrumentGrid />

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
