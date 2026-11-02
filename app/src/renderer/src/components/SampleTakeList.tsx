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

type RegionState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; peaks: Peak[]; totalSamples: number }

// loop_start/loop_end are sample-frame offsets at the file's own native
// rate - approximated here against the decoded AudioBuffer's length, which
// can differ slightly if the browser resampled on decode. Fine for a visual
// reference; not precise enough to drive actual sample-accurate editing.
function regionLoopRange(region: RegionInfo): { start: number; end: number } | null {
  const start = Number(region.opcodes.find((op) => op.name === 'loop_start')?.value)
  const end = Number(region.opcodes.find((op) => op.name === 'loop_end')?.value)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end }
}

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
// stereo pair) shows all of them, not just one picked arbitrarily, plus a
// "play take" button that fires all of that take's regions together - that
// matches actual SFZ playback (every region sharing one sound identity
// triggers simultaneously), unlike round-robin alternatives across
// different takes, which are mutually exclusive per note-on and so never
// get a combined play control.
//
// Decoding happens once here (not per-row) so playing a take can fire every
// one of its regions' already-decoded buffers at the same scheduled start
// time, instead of re-fetching/re-decoding on click.
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
            [key]: {
              status: 'ready',
              peaks: computePeaks(audioBuffer, PEAK_BARS),
              totalSamples: audioBuffer.length
            }
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

  // Scheduled at the same future instant for every region in the take
  // rather than started back-to-back in a loop, so node-creation overhead
  // doesn't stagger the actual playback - this is what real SFZ playback
  // does too (one note-on fires every region sharing that sound identity).
  function playTake(takeIndex: number, take: TakeInfo): void {
    const ctx = audioCtxRef.current
    if (!ctx) return
    ctx.resume()
    const startAt = ctx.currentTime + 0.05
    take.regions.forEach((region, ri) => {
      const key = `${takeIndex}-${ri}-${region.samplePath}`
      const buffer = buffersRef.current.get(key)
      if (!buffer) return
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const panner = ctx.createStereoPanner()
      panner.pan.value = regionPan(region)
      source.connect(panner).connect(ctx.destination)
      source.start(startAt)
    })
  }

  if (!cell || cell.samples.length === 0) {
    return (
      <div className="sample-take-list">
        <div className="sample-take-list__empty">select a cell to see its samples</div>
      </div>
    )
  }

  return (
    <div className="sample-take-list">
      <div className="sample-take-list__scroll">
        {cell.samples.map((take, i) => (
          <TakeItem
            key={`${take.regions[0]?.samplePath}-${i}`}
            takeIndex={i}
            take={take}
            regionStates={regionStates}
            onPlayRegion={playRegion}
            onPlayTake={playTake}
          />
        ))}
      </div>
    </div>
  )
}

interface TakeItemProps {
  takeIndex: number
  take: TakeInfo
  regionStates: Record<string, RegionState>
  onPlayRegion: (key: string, region: RegionInfo) => void
  onPlayTake: (takeIndex: number, take: TakeInfo) => void
}

function TakeItem({
  takeIndex,
  take,
  regionStates,
  onPlayRegion,
  onPlayTake
}: TakeItemProps): React.JSX.Element {
  // Only regions within one take actually fire together on a single
  // note-on (e.g. a stereo L/R pair) - a single-region take has nothing a
  // combined button would add over its own row's play button.
  const isGrouped = take.regions.length > 1
  const anyReady = take.regions.some((region, ri) => {
    const key = `${takeIndex}-${ri}-${region.samplePath}`
    return regionStates[key]?.status === 'ready'
  })

  return (
    <div className="sample-take-list__item">
      <div className="sample-take-list__regions">
        {take.regions.map((region, i) => {
          // Must match flattenRegions' key format exactly - this is how a
          // row finds its own decoded buffer/peaks in the shared state above.
          const key = `${takeIndex}-${i}-${region.samplePath}`
          return (
            <RegionRow
              key={key}
              region={region}
              state={regionStates[key]}
              onPlay={() => onPlayRegion(key, region)}
            />
          )
        })}
      </div>
      {isGrouped && (
        <button
          type="button"
          className="sample-take-list__play-take"
          onClick={() => onPlayTake(takeIndex, take)}
          disabled={!anyReady}
          title="Play every region in this take together"
          aria-label="Play take"
        >
          ▶
        </button>
      )}
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
          {state?.status === 'ready' && (
            <Waveform
              peaks={state.peaks}
              totalSamples={state.totalSamples}
              loopRange={regionLoopRange(region)}
            />
          )}
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

interface WaveformProps {
  peaks: Peak[]
  totalSamples: number
  loopRange: { start: number; end: number } | null
}

function Waveform({ peaks, totalSamples, loopRange }: WaveformProps): React.JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      className="sample-take-list__svg"
    >
      {/* Drawn first (behind the bars) - just a reference for where
          loop_start/loop_end currently sit, not yet editable. */}
      {loopRange && totalSamples > 0 && (
        <rect
          className="sample-take-list__loop-region"
          x={(loopRange.start / totalSamples) * peaks.length}
          y={0}
          width={((loopRange.end - loopRange.start) / totalSamples) * peaks.length}
          height={100}
        />
      )}
      {peaks.map(([min, max], i) => {
        const top = 50 - max * 50
        const bottom = 50 - min * 50
        const height = Math.max(1, bottom - top)
        return <rect key={i} x={i} y={top} width={1} height={height} />
      })}
    </svg>
  )
}
