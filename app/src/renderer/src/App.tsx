import { useEffect, useState } from 'react'

interface HealthResponse {
  status: string
  version: string
}

export default function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startupMs, setStartupMs] = useState<number | null>(null)

  // Measured on first render of this screen, independent of sidecar status,
  // so it always reports how long launch took to reach visible UI.
  useEffect(() => {
    window.api.getStartTime().then((startTime) => {
      setStartupMs(Math.round(Date.now() - startTime))
    })
  }, [])

  useEffect(() => {
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
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>Subito sfz</h1>
      <p style={{ color: '#888', fontSize: '0.85rem' }}>
        {startupMs === null ? 'Measuring startup time…' : `Ready in ${startupMs}ms`}
      </p>
      {error && <p style={{ color: 'crimson' }}>Sidecar error: {error}</p>}
      {!error && !health && <p>Connecting to local server…</p>}
      {health && (
        <p>
          Server status: <strong>{health.status}</strong> (v{health.version})
        </p>
      )}
    </div>
  )
}
