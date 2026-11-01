import { useEffect, useState } from 'react'
import type { CellRecord, TakeInfo } from '../model/instrument'
import './SampleTakeList.css'

interface Props {
  cell: CellRecord | null
  sfzFilePath: string | null
  onPlay: (samplePath: string) => void
}

// Replaces what used to be a single trust-me "takes: N" number in the
// criteria panel with the actual files behind it - one row per real sample,
// each independently loaded, drawn, and playable, so the count is something
// you can see rather than just believe.
export default function SampleTakeList({ cell, sfzFilePath, onPlay }: Props): React.JSX.Element {
  if (!cell || cell.samples.length === 0) {
    return (
      <div className="sample-take-list">
        <div className="sample-take-list__empty">select a cell to see its samples</div>
      </div>
    )
  }

  return (
    <div className="sample-take-list">
      {cell.samples.map((take, i) => (
        <TakeRow
          key={`${take.samplePath}-${i}`}
          sfzFilePath={sfzFilePath}
          take={take}
          onPlay={() => onPlay(take.samplePath)}
        />
      ))}
    </div>
  )
}

interface TakeRowProps {
  sfzFilePath: string | null
  take: TakeInfo
  onPlay: () => void
}

function TakeRow({ sfzFilePath, take, onPlay }: TakeRowProps): React.JSX.Element {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opcodesOpen, setOpcodesOpen] = useState(false)
  const samplePath = take.samplePath

  useEffect(() => {
    let cancelled = false
    setPeaks(null)
    setError(null)
    if (!sfzFilePath) return

    let ctx: AudioContext | null = null
    async function load(): Promise<void> {
      try {
        const bytes = await window.api.readAudioFile(sfzFilePath as string, samplePath)
        // Copy into a right-sized standalone buffer - decodeAudioData wants
        // an ArrayBuffer, and the IPC-returned view may sit on a differently
        // sized backing buffer.
        const arrayBuffer = bytes.slice().buffer as ArrayBuffer
        ctx = new AudioContext()
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
        if (cancelled) return
        setPeaks(computePeaks(audioBuffer, 100))
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        ctx?.close()
      }
    }
    load()

    return () => {
      cancelled = true
    }
  }, [sfzFilePath, samplePath])

  const fileName = samplePath.split(/[/\\]/).pop() ?? samplePath

  return (
    <div className="sample-take-list__item">
      <div className="sample-take-list__row">
        <button type="button" className="sample-take-list__play" onClick={onPlay}>
          ▶
        </button>
        <span className="sample-take-list__name" title={samplePath}>
          {fileName}
        </span>
        <div className="sample-take-list__waveform">
          {error && <span className="sample-take-list__status">failed to load</span>}
          {!error && !peaks && <span className="sample-take-list__status">loading…</span>}
          {!error && peaks && <Waveform peaks={peaks} />}
        </div>
        <button
          type="button"
          className="sample-take-list__toggle"
          onClick={() => setOpcodesOpen((v) => !v)}
          aria-label={opcodesOpen ? 'Hide opcodes' : 'Show opcodes'}
        >
          {opcodesOpen ? '▾' : '▸'}
        </button>
      </div>
      {opcodesOpen && (
        <div className="sample-take-list__opcodes">
          {take.opcodes.map((op) => (
            <div className="sample-take-list__opcode" key={op.name}>
              <span className="sample-take-list__opcode-name">{op.name}</span>
              <span className="sample-take-list__opcode-value">{op.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function computePeaks(buffer: AudioBuffer, bars: number): number[] {
  const data = buffer.getChannelData(0)
  const blockSize = Math.max(1, Math.floor(data.length / bars))
  const peaks: number[] = []
  for (let i = 0; i < bars; i++) {
    const start = i * blockSize
    let max = 0
    for (let j = start; j < start + blockSize && j < data.length; j++) {
      const v = Math.abs(data[j])
      if (v > max) max = v
    }
    peaks.push(max)
  }
  return peaks
}

function Waveform({ peaks }: { peaks: number[] }): React.JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      className="sample-take-list__svg"
    >
      {peaks.map((p, i) => {
        const h = Math.max(2, p * 100)
        return <rect key={i} x={i} y={(100 - h) / 2} width={0.8} height={h} />
      })}
    </svg>
  )
}
