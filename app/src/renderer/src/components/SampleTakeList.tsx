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
  const [peaks, setPeaks] = useState<Peak[] | null>(null)
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
        setPeaks(computePeaks(audioBuffer, PEAK_BARS))
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

// High enough that even a several-second sample doesn't look blocky at the
// waveform box's rendered width - SVG scales crisply, so the only real
// resolution lever is how many [min, max] slices we actually compute.
const PEAK_BARS = 600

type Peak = [min: number, max: number]

// Real top/bottom excursion per slice, not just an abs-max mirrored around
// the centerline - that's what makes the shape look like an actual waveform
// (asymmetric attack transients, etc.) instead of a symmetric bar chart.
// Normalized against the sample's own loudest slice, not the theoretical
// [-1, 1] range - most samples never get near full scale, so without this
// the drawn shape would sit shrunk in the middle of the box instead of
// reaching its top/bottom edge.
function computePeaks(buffer: AudioBuffer, bars: number): Peak[] {
  const data = buffer.getChannelData(0)
  const blockSize = Math.max(1, Math.floor(data.length / bars))
  const peaks: Peak[] = []
  let peakAbs = 0
  for (let i = 0; i < bars; i++) {
    const start = i * blockSize
    let min = 0
    let max = 0
    for (let j = start; j < start + blockSize && j < data.length; j++) {
      const v = data[j]
      if (v > max) max = v
      if (v < min) min = v
    }
    peakAbs = Math.max(peakAbs, max, -min)
    peaks.push([min, max])
  }
  if (peakAbs === 0) return peaks
  return peaks.map(([min, max]) => [min / peakAbs, max / peakAbs])
}

function Waveform({ peaks }: { peaks: Peak[] }): React.JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      className="sample-take-list__svg"
    >
      {peaks.map(([min, max], i) => {
        const top = 50 - max * 50
        const bottom = 50 - min * 50
        const height = Math.max(1, bottom - top)
        return <rect key={i} x={i} y={top} width={1} height={height} />
      })}
    </svg>
  )
}
