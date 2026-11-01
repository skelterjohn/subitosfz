import { useEffect, useRef, useState } from 'react'
import type { CellRecord, RegionInfo, TakeInfo } from '../model/instrument'
import './SampleTakeList.css'

interface Props {
  cell: CellRecord | null
  sfzFilePath: string | null
}

// Replaces what used to be a single trust-me "takes: N" number in the
// criteria panel with the actual files behind it - one box per take, each
// independently loaded, drawn, and playable, so the count is something you
// can see rather than just believe. A take with multiple regions (e.g. a
// stereo pair) shows all of them, not just one picked arbitrarily.
export default function SampleTakeList({ cell, sfzFilePath }: Props): React.JSX.Element {
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
        <TakeItem key={`${take.regions[0]?.samplePath}-${i}`} take={take} sfzFilePath={sfzFilePath} />
      ))}
    </div>
  )
}

interface TakeItemProps {
  take: TakeInfo
  sfzFilePath: string | null
}

function TakeItem({ take, sfzFilePath }: TakeItemProps): React.JSX.Element {
  return (
    <div className="sample-take-list__item">
      {take.regions.map((region, i) => (
        <RegionRow key={`${region.samplePath}-${i}`} sfzFilePath={sfzFilePath} region={region} />
      ))}
    </div>
  )
}

interface RegionRowProps {
  sfzFilePath: string | null
  region: RegionInfo
}

// The sample files are routinely mono, with the actual stereo placement
// coming entirely from the SFZ pan opcode (-100..100) at playback time - a
// plain <audio>/Blob-URL player has no idea that opcode exists, so it plays
// everything dead center. Playback here goes through a real Web Audio graph
// (the same decoded buffer used for the waveform) so pan is actually heard.
function RegionRow({ sfzFilePath, region }: RegionRowProps): React.JSX.Element {
  const [peaks, setPeaks] = useState<Peak[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opcodesOpen, setOpcodesOpen] = useState(false)
  const samplePath = region.samplePath
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioBufferRef = useRef<AudioBuffer | null>(null)

  useEffect(() => {
    let cancelled = false
    setPeaks(null)
    setError(null)
    audioBufferRef.current = null
    if (!sfzFilePath) return

    const ctx = new AudioContext()
    audioCtxRef.current = ctx

    async function load(): Promise<void> {
      try {
        const bytes = await window.api.readAudioFile(sfzFilePath as string, samplePath)
        // Copy into a right-sized standalone buffer - decodeAudioData wants
        // an ArrayBuffer, and the IPC-returned view may sit on a differently
        // sized backing buffer.
        const arrayBuffer = bytes.slice().buffer as ArrayBuffer
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
        if (cancelled) return
        audioBufferRef.current = audioBuffer
        setPeaks(computePeaks(audioBuffer, PEAK_BARS))
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    }
    load()

    return () => {
      cancelled = true
      ctx.close()
      audioCtxRef.current = null
    }
  }, [sfzFilePath, samplePath])

  const panOpcode = region.opcodes.find((op) => op.name === 'pan')?.value
  const panValue = panOpcode !== undefined ? Number(panOpcode) : 0
  const pan = Number.isFinite(panValue) ? Math.max(-1, Math.min(1, panValue / 100)) : 0

  function handlePlay(): void {
    const ctx = audioCtxRef.current
    const buffer = audioBufferRef.current
    if (!ctx || !buffer) return
    ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const panner = ctx.createStereoPanner()
    panner.pan.value = pan
    source.connect(panner).connect(ctx.destination)
    source.start()
  }

  const fileName = samplePath.split(/[/\\]/).pop() ?? samplePath

  return (
    <div className="sample-take-list__region">
      <div className="sample-take-list__row">
        <button
          type="button"
          className="sample-take-list__play"
          onClick={handlePlay}
          disabled={!peaks}
        >
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
          {region.opcodes.map((op) => (
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
