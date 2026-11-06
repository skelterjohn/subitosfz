import { useEffect, useRef, useState } from 'react'
import type { DrawerChunk } from '../model/drawer'
import './ChunkDrawer.css'

interface Props {
  chunks: DrawerChunk[]
  sfzFilePath: string | null
  onAssign: (chunk: DrawerChunk) => void
}

type ChunkState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; durationSec: number }

// One AudioContext/buffer cache for the whole drawer's lifetime, keyed by
// filename (unique within a project directory) - a chunk played here is a
// flat preview, no envelope/loop/take-grouping the way SampleTakeList needs,
// since it hasn't been assigned to anything yet.
export default function ChunkDrawer({ chunks, sfzFilePath, onAssign }: Props): React.JSX.Element {
  // Closed by default - this is a drawer, not a permanent panel. The tab
  // stays visible/clickable either way, so there's always a way back in.
  const [open, setOpen] = useState(false)
  const [states, setStates] = useState<Record<string, ChunkState>>({})
  const audioCtxRef = useRef<AudioContext | null>(null)
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map())
  // Which filenames already have a decode in flight or finished - tracked
  // separately from `states` so kicking off new decodes doesn't need
  // `states` itself in this effect's dependency array.
  const startedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    return () => {
      ctx.close()
      audioCtxRef.current = null
    }
  }, [])

  useEffect(() => {
    const ctx = audioCtxRef.current
    if (!ctx || !sfzFilePath) return
    let cancelled = false

    chunks.forEach(({ fileName }) => {
      if (startedRef.current.has(fileName)) return
      startedRef.current.add(fileName)
      setStates((prev) => ({ ...prev, [fileName]: { status: 'loading' } }))
      ;(async () => {
        try {
          const bytes = await window.api.readAudioFile(sfzFilePath, fileName)
          const arrayBuffer = bytes.slice().buffer as ArrayBuffer
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
          if (cancelled) return
          buffersRef.current.set(fileName, audioBuffer)
          setStates((prev) => ({
            ...prev,
            [fileName]: { status: 'ready', durationSec: audioBuffer.duration }
          }))
        } catch {
          if (!cancelled) setStates((prev) => ({ ...prev, [fileName]: { status: 'error' } }))
        }
      })()
    })

    return () => {
      cancelled = true
    }
  }, [chunks, sfzFilePath])

  function play(fileName: string): void {
    const ctx = audioCtxRef.current
    const buffer = buffersRef.current.get(fileName)
    if (!ctx || !buffer) return
    ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
  }

  return (
    <>
      <button
        type="button"
        className={`chunk-drawer__tab${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close sample drawer' : 'Open sample drawer'}
        aria-expanded={open}
      >
        <span className="chunk-drawer__tab-arrow" aria-hidden="true">
          {open ? '›' : '‹'}
        </span>
        {chunks.length > 0 && <span className="chunk-drawer__badge">{chunks.length}</span>}
      </button>
      <div className={`chunk-drawer${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="chunk-drawer__header">Unassigned samples</div>
        {chunks.length === 0 ? (
          <div className="chunk-drawer__empty">nothing waiting to be assigned</div>
        ) : (
          <div className="chunk-drawer__list">
            {chunks.map(({ fileName }) => {
              const state = states[fileName]
              return (
                <div key={fileName} className="chunk-drawer__item">
                  <button
                    type="button"
                    className="chunk-drawer__play"
                    onClick={() => play(fileName)}
                    disabled={state?.status !== 'ready'}
                    aria-label="Play this sample"
                  >
                    ▶
                  </button>
                  <div className="chunk-drawer__name" title={fileName}>
                    <span className="chunk-drawer__filename">{fileName}</span>
                    {state?.status === 'ready' && (
                      <span className="chunk-drawer__duration">{state.durationSec.toFixed(2)}s</span>
                    )}
                    {state?.status === 'error' && (
                      <span className="chunk-drawer__duration">failed to load</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="chunk-drawer__assign"
                    onClick={() => onAssign({ fileName })}
                  >
                    Assign…
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
