import { useEffect, useRef, useState } from 'react'
import type { DrawerChunk } from '../model/drawer'
import './ChunkDrawer.css'

interface Props {
  chunks: DrawerChunk[]
  sfzFilePath: string | null
  onAssign: (chunk: DrawerChunk) => void
  // Fired after a sample is deleted from disk, so the parent knows to
  // rescan the project directory - deleting doesn't touch the .sfz or the
  // instrument, so nothing else would otherwise trigger that rescan.
  onDeleted: () => void
}

type ChunkState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; durationSec: number }

function AssignIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <polyline
        points="4 12 10 18 20 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <line x1="10" y1="11" x2="10" y2="17" />
        <line x1="14" y1="11" x2="14" y2="17" />
      </g>
    </svg>
  )
}

// One AudioContext/buffer cache for the whole drawer's lifetime, keyed by
// filename (unique within a project directory) - a chunk played here is a
// flat preview, no envelope/loop/take-grouping the way SampleTakeList needs,
// since it hasn't been assigned to anything yet.
export default function ChunkDrawer({ chunks, sfzFilePath, onAssign, onDeleted }: Props): React.JSX.Element {
  // Closed by default - this is a drawer, not a permanent panel. The tab
  // stays visible/clickable either way, so there's always a way back in.
  const [open, setOpen] = useState(false)
  const [states, setStates] = useState<Record<string, ChunkState>>({})
  const [deletingFiles, setDeletingFiles] = useState<Set<string>>(new Set())
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

  async function remove(fileName: string): Promise<void> {
    if (!sfzFilePath || deletingFiles.has(fileName)) return
    // Deleting from disk is irreversible - unlike assigning (which is just
    // writing a region), there's no later edit that undoes this.
    if (!window.confirm(`Delete "${fileName}" from disk? This can't be undone.`)) return

    setDeletingFiles((prev) => new Set(prev).add(fileName))
    try {
      await window.api.deleteSampleFile(sfzFilePath, fileName)
      buffersRef.current.delete(fileName)
      startedRef.current.delete(fileName)
      onDeleted()
    } catch (err) {
      window.alert(`Failed to delete "${fileName}": ${String(err)}`)
      setDeletingFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
    }
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
                    disabled={deletingFiles.has(fileName)}
                    aria-label="Assign this sample"
                    title="Assign to a cell"
                  >
                    <AssignIcon />
                  </button>
                  <button
                    type="button"
                    className="chunk-drawer__delete"
                    onClick={() => remove(fileName)}
                    disabled={deletingFiles.has(fileName)}
                    aria-label="Delete this sample"
                    title="Delete from disk"
                  >
                    <TrashIcon />
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
