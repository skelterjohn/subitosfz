import { useEffect, useRef, useState } from 'react'
import type { CellRecord, RegionInfo, TakeInfo } from '../model/instrument'
import './SampleTakeList.css'

interface Props {
  cell: CellRecord | null
  sfzFilePath: string | null
}

interface FlatRegion {
  key: string
  region: RegionInfo
}

function flattenRegions(cell: CellRecord): FlatRegion[] {
  const out: FlatRegion[] = []
  cell.samples.forEach((take, ti) => {
    take.regions.forEach((region, ri) => {
      out.push({ key: `${ti}-${ri}-${region.samplePath}`, region })
    })
  })
  return out
}

type RegionState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; peaks: Peak[] }

// The sample files are routinely mono, with the actual stereo placement
// coming entirely from the SFZ pan opcode (-100..100) at playback time - a
// plain <audio>/Blob-URL player has no idea that opcode exists, so it plays
// everything dead center. Playback goes through a real Web Audio graph with
// a pan node driven by that region's own opcode.
function regionPan(region: RegionInfo): number {
  const panOpcode = region.opcodes.find((op) => op.name === 'pan')?.value
  const panValue = panOpcode !== undefined ? Number(panOpcode) : 0
  return Number.isFinite(panValue) ? Math.max(-1, Math.min(1, panValue / 100)) : 0
}

// Replaces what used to be a single trust-me "takes: N" number in the
// criteria panel with the actual files behind it - one box per take, each
// independently loaded, drawn, and playable, so the count is something you
// can see rather than just believe. A take with multiple regions (e.g. a
// stereo pair) shows all of them, not just one picked arbitrarily.
//
// Decoding happens once here (not per-row) so "play all" can fire every
// region's already-decoded buffer at the same scheduled start time, instead
// of re-fetching/re-decoding on click.
export default function SampleTakeList({ cell, sfzFilePath }: Props): React.JSX.Element {
  const [regionStates, setRegionStates] = useState<Record<string, RegionState>>({})
  const audioCtxRef = useRef<AudioContext | null>(null)
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map())

  useEffect(() => {
    buffersRef.current = new Map()
    setRegionStates({})
    if (!cell || !sfzFilePath) return

    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const regions = flattenRegions(cell)
    setRegionStates(Object.fromEntries(regions.map((r) => [r.key, { status: 'loading' }])))

    let cancelled = false
    regions.forEach(({ key, region }) => {
      ;(async () => {
        try {
          const bytes = await window.api.readAudioFile(sfzFilePath, region.samplePath)
          // Copy into a right-sized standalone buffer - decodeAudioData
          // wants an ArrayBuffer, and the IPC-returned view may sit on a
          // differently sized backing buffer.
          const arrayBuffer = bytes.slice().buffer as ArrayBuffer
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
          if (cancelled) return
          buffersRef.current.set(key, audioBuffer)
          setRegionStates((prev) => ({
            ...prev,
            [key]: { status: 'ready', peaks: computePeaks(audioBuffer, PEAK_BARS) }
          }))
        } catch {
          if (!cancelled) setRegionStates((prev) => ({ ...prev, [key]: { status: 'error' } }))
        }
      })()
    })

    return () => {
      cancelled = true
      ctx.close()
      audioCtxRef.current = null
    }
  }, [cell, sfzFilePath])

  function playRegion(key: string, region: RegionInfo): void {
    const ctx = audioCtxRef.current
    const buffer = buffersRef.current.get(key)
    if (!ctx || !buffer) return
    ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const panner = ctx.createStereoPanner()
    panner.pan.value = regionPan(region)
    source.connect(panner).connect(ctx.destination)
    source.start()
  }

  // Scheduled at the same future instant for every region rather than
  // started back-to-back in a loop, so node-creation overhead doesn't
  // stagger the actual playback - this is the whole point of the button:
  // judging whether regions genuinely belong together by ear.
  function playAll(): void {
    const ctx = audioCtxRef.current
    if (!ctx || !cell) return
    ctx.resume()
    const startAt = ctx.currentTime + 0.05
    for (const { key, region } of flattenRegions(cell)) {
      const buffer = buffersRef.current.get(key)
      if (!buffer) continue
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const panner = ctx.createStereoPanner()
      panner.pan.value = regionPan(region)
      source.connect(panner).connect(ctx.destination)
      source.start(startAt)
    }
  }

  if (!cell || cell.samples.length === 0) {
    return (
      <div className="sample-take-list">
        <div className="sample-take-list__empty">select a cell to see its samples</div>
      </div>
    )
  }

  const anyReady = Object.values(regionStates).some((s) => s.status === 'ready')

  return (
    <div className="sample-take-list">
      <div className="sample-take-list__scroll">
        {cell.samples.map((take, i) => (
          <TakeItem
            key={`${take.regions[0]?.samplePath}-${i}`}
            takeIndex={i}
            take={take}
            regionStates={regionStates}
            onPlay={playRegion}
          />
        ))}
      </div>
      <button
        type="button"
        className="sample-take-list__play-all"
        onClick={playAll}
        disabled={!anyReady}
      >
        ▶ play all
      </button>
    </div>
  )
}

interface TakeItemProps {
  takeIndex: number
  take: TakeInfo
  regionStates: Record<string, RegionState>
  onPlay: (key: string, region: RegionInfo) => void
}

function TakeItem({ takeIndex, take, regionStates, onPlay }: TakeItemProps): React.JSX.Element {
  return (
    <div className="sample-take-list__item">
      {take.regions.map((region, i) => {
        // Must match flattenRegions' key format exactly - this is how a
        // row finds its own decoded buffer/peaks in the shared state above.
        const key = `${takeIndex}-${i}-${region.samplePath}`
        return (
          <RegionRow
            key={key}
            region={region}
            state={regionStates[key]}
            onPlay={() => onPlay(key, region)}
          />
        )
      })}
    </div>
  )
}

interface RegionRowProps {
  region: RegionInfo
  state: RegionState | undefined
  onPlay: () => void
}

function RegionRow({ region, state, onPlay }: RegionRowProps): React.JSX.Element {
  const [opcodesOpen, setOpcodesOpen] = useState(false)
  const samplePath = region.samplePath
  const fileName = samplePath.split(/[/\\]/).pop() ?? samplePath
  const isReady = state?.status === 'ready'

  return (
    <div className="sample-take-list__region">
      <div className="sample-take-list__row">
        <button
          type="button"
          className="sample-take-list__play"
          onClick={onPlay}
          disabled={!isReady}
        >
          ▶
        </button>
        <span className="sample-take-list__name" title={samplePath}>
          {fileName}
        </span>
        <div className="sample-take-list__waveform">
          {state?.status === 'error' && (
            <span className="sample-take-list__status">failed to load</span>
          )}
          {(!state || state.status === 'loading') && (
            <span className="sample-take-list__status">loading…</span>
          )}
          {state?.status === 'ready' && <Waveform peaks={state.peaks} />}
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
