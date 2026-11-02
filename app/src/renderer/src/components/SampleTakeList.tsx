import { useEffect, useRef, useState } from 'react'
import type { CellRecord, OpcodeEntry, RegionInfo, TakeInfo } from '../model/instrument'
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

// What a currently-sounding region needs in order to compute, on demand,
// where its playhead currently sits - recomputed each animation frame
// rather than stored as a moving number, since "now" only exists as
// ctx.currentTime at read time. durationSec is always the buffer's own
// natural duration: a looped take preview now runs the loop for a while
// and then continues into the sample's own tail rather than being cut off
// mid-loop, so it always ends wherever the file itself ends.
interface PlaybackInfo {
  startAt: number
  durationSec: number
  loopStartSec: number | null
  loopEndSec: number | null
  // ctx-time instant looping gets switched off (null if this play isn't
  // looping at all) - after this instant playback keeps going forward from
  // wherever it was in the loop cycle, rather than wrapping again.
  loopReleaseAt: number | null
}

// Fraction (0..1) of the waveform's width the playhead currently sits at,
// or null once playback has finished (or hasn't started yet) - null means
// "don't draw a line" to the caller.
function playbackFraction(info: PlaybackInfo, now: number): number | null {
  const elapsed = now - info.startAt
  if (elapsed < 0 || elapsed > info.durationSec) return null
  let posSec = elapsed
  if (info.loopStartSec !== null && info.loopEndSec !== null && elapsed > info.loopStartSec) {
    const loopLen = info.loopEndSec - info.loopStartSec
    const releaseElapsed =
      info.loopReleaseAt !== null ? info.loopReleaseAt - info.startAt : Infinity
    if (elapsed < releaseElapsed) {
      posSec = info.loopStartSec + ((elapsed - info.loopStartSec) % loopLen)
    } else {
      // Loop has been switched off - keep advancing linearly from exactly
      // where it was in the loop cycle at the moment of release, matching
      // what the AudioBufferSourceNode itself actually does.
      const posAtRelease = info.loopStartSec + ((releaseElapsed - info.loopStartSec) % loopLen)
      posSec = posAtRelease + (elapsed - releaseElapsed)
    }
  }
  return Math.min(1, posSec / info.durationSec)
}

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
  const [playheads, setPlayheads] = useState<Record<string, number>>({})
  const audioCtxRef = useRef<AudioContext | null>(null)
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map())
  const activePlaybackRef = useRef<Map<string, PlaybackInfo>>(new Map())
  const rafRef = useRef<number | null>(null)

  // Drives the playhead line: as long as anything is actively playing,
  // recompute every active region's fraction each frame from ctx.currentTime
  // (there's no other clock to read a "current position" from) and push
  // them all into state at once, rather than one timer per region.
  function tick(): void {
    const ctx = audioCtxRef.current
    if (!ctx) {
      rafRef.current = null
      return
    }
    const now = ctx.currentTime
    const next: Record<string, number> = {}
    activePlaybackRef.current.forEach((info, key) => {
      const elapsed = now - info.startAt
      // Scheduled a little into the future for sync (see startAt below) -
      // the first frame or two can land before it actually starts, which is
      // "nothing to draw yet", not "finished" - only drop the entry once
      // we're actually past its end.
      if (elapsed > info.durationSec) {
        activePlaybackRef.current.delete(key)
        return
      }
      if (elapsed < 0) return
      const frac = playbackFraction(info, now)
      if (frac !== null) next[key] = frac
    })
    setPlayheads(next)
    rafRef.current = activePlaybackRef.current.size > 0 ? requestAnimationFrame(tick) : null
  }

  function registerPlayback(key: string, info: PlaybackInfo): void {
    activePlaybackRef.current.set(key, info)
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick)
  }

  useEffect(() => {
    buffersRef.current = new Map()
    setRegionStates({})
    activePlaybackRef.current.clear()
    setPlayheads({})
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
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
    const startAt = ctx.currentTime + 0.05
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const panner = ctx.createStereoPanner()
    panner.pan.value = regionPan(region)
    source.connect(panner).connect(ctx.destination)
    source.start(startAt)
    registerPlayback(key, {
      startAt,
      durationSec: buffer.duration,
      loopStartSec: null,
      loopEndSec: null,
      loopReleaseAt: null
    })
  }

  // Scheduled at the same future instant for every region in the take
  // rather than started back-to-back in a loop, so node-creation overhead
  // doesn't stagger the actual playback - this is what real SFZ playback
  // does too (one note-on fires every region sharing that sound identity).
  // With loop on, each region's own loop_start/loop_end opcodes drive the
  // native AudioBufferSourceNode loop (so a region without a loop range
  // just plays through once, untouched). The loop point is timed from when
  // the loop actually starts, not from note-on - loop_start commonly sits
  // several seconds into these files (a long natural attack/decay before
  // the short sustain segment that gets looped), so a flat "N seconds after
  // note-on" would switch the loop off before it was ever reached.
  function playTake(takeIndex: number, take: TakeInfo, loop: boolean): void {
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
      const loopRange = loop ? regionLoopRange(region) : null
      source.start(startAt)
      let loopStartSec: number | null = null
      let loopEndSec: number | null = null
      let loopReleaseAt: number | null = null
      if (loopRange) {
        loopStartSec = loopRange.start / buffer.sampleRate
        loopEndSec = loopRange.end / buffer.sampleRate
        source.loop = true
        source.loopStart = loopStartSec
        source.loopEnd = loopEndSec
        loopReleaseAt = startAt + loopStartSec + LOOP_PREVIEW_SECONDS
        // No stop() here - switching the loop flag off (rather than
        // stopping the node) lets it keep playing forward from wherever
        // it is in the loop cycle, through to the sample's own natural
        // end/tail, instead of cutting it off mid-loop. There's no
        // sample-accurate way to schedule a plain attribute flip, so this
        // is a JS timer against wall-clock time rather than the audio
        // clock - fine for a preview control, not meant to be sample-exact.
        const delayMs = Math.max(0, (loopReleaseAt - ctx.currentTime) * 1000)
        setTimeout(() => {
          source.loop = false
        }, delayMs)
      }
      registerPlayback(key, {
        startAt,
        durationSec: buffer.duration,
        loopStartSec,
        loopEndSec,
        loopReleaseAt
      })
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
            playheads={playheads}
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
  playheads: Record<string, number>
  onPlayRegion: (key: string, region: RegionInfo) => void
  onPlayTake: (takeIndex: number, take: TakeInfo, loop: boolean) => void
}

function TakeItem({
  takeIndex,
  take,
  regionStates,
  playheads,
  onPlayRegion,
  onPlayTake
}: TakeItemProps): React.JSX.Element {
  const [loopEnabled, setLoopEnabled] = useState(false)
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
              playheadFraction={playheads[key]}
              onPlay={() => onPlayRegion(key, region)}
            />
          )
        })}
      </div>
      {/* The only play control visible on a folded row - an individual
          region's own play button only shows once its opcode panel is
          unfolded, so the collapsed view always has exactly one play
          button regardless of take size. The loop toggle sits above it
          rather than beside it, so the pair still reads as one column at
          the fixed 48px width the row layout expects. */}
      <div className="sample-take-list__play-take-col">
        <button
          type="button"
          className={
            'sample-take-list__loop-toggle' +
            (loopEnabled ? ' sample-take-list__loop-toggle--active' : '')
          }
          onClick={() => setLoopEnabled((v) => !v)}
          aria-pressed={loopEnabled}
          aria-label="Loop the sustain region for 3 seconds before stopping"
          title="Loop the sustain region for 3 seconds before stopping"
        >
          ↻
        </button>
        <button
          type="button"
          className="sample-take-list__play-take"
          onClick={() => onPlayTake(takeIndex, take, loopEnabled)}
          disabled={!anyReady}
          title="Play this take"
          aria-label="Play take"
        >
          ▶
        </button>
      </div>
    </div>
  )
}

interface RegionRowProps {
  region: RegionInfo
  state: RegionState | undefined
  playheadFraction: number | undefined
  onPlay: () => void
}

function RegionRow({ region, state, playheadFraction, onPlay }: RegionRowProps): React.JSX.Element {
  const [opcodesOpen, setOpcodesOpen] = useState(false)
  const samplePath = region.samplePath
  const fileName = samplePath.split(/[/\\]/).pop() ?? samplePath
  const isReady = state?.status === 'ready'
  const globalOpcodes = region.opcodes.filter((op) => op.isGlobal)
  const localOpcodes = region.opcodes.filter((op) => !op.isGlobal)

  return (
    <div className="sample-take-list__region">
      <div className="sample-take-list__row">
        <button
          type="button"
          className="sample-take-list__toggle"
          onClick={() => setOpcodesOpen((v) => !v)}
          aria-label={opcodesOpen ? 'Hide opcodes' : 'Show opcodes'}
        >
          {opcodesOpen ? '▾' : '▸'}
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
              playheadFraction={playheadFraction}
            />
          )}
        </div>
      </div>
      {opcodesOpen && (
        <div className="sample-take-list__opcodes">
          {/* This region's own play button - only reachable once unfolded,
              since the folded row relies on the take's single combined
              button instead. */}
          <button
            type="button"
            className="sample-take-list__play"
            onClick={onPlay}
            disabled={!isReady}
            aria-label="Play this sample"
          >
            ▶
          </button>
          {/* Globals first (per the backend's own ordering), set off with a
              vertical rail rather than a divider line - local opcodes below
              read as the "default" flush-left case. */}
          {globalOpcodes.length > 0 && (
            <div className="sample-take-list__opcode-group">
              <span className="sample-take-list__opcode-rail">global</span>
              <div className="sample-take-list__opcode-rows">
                {globalOpcodes.map((op) => (
                  <OpcodeRow key={op.name} op={op} />
                ))}
              </div>
            </div>
          )}
          {localOpcodes.length > 0 && (
            <div className="sample-take-list__opcode-rows">
              {localOpcodes.map((op) => (
                <OpcodeRow key={op.name} op={op} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OpcodeRow({ op }: { op: OpcodeEntry }): React.JSX.Element {
  return (
    <div className="sample-take-list__opcode">
      <span className="sample-take-list__opcode-name">{op.name}</span>
      <span className="sample-take-list__opcode-value">{op.value}</span>
    </div>
  )
}

// How long a looped take preview runs before being cut off - long enough to
// actually hear the sustain loop repeat a few times, short enough not to
// drone on when the loop point is short.
const LOOP_PREVIEW_SECONDS = 3

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
  playheadFraction: number | undefined
}

function Waveform({
  peaks,
  totalSamples,
  loopRange,
  playheadFraction
}: WaveformProps): React.JSX.Element {
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
      {/* Drawn last (on top of the bars) - this is a live position, not a
          fixed reference like the loop-region rect above. */}
      {playheadFraction !== undefined && (
        <line
          className="sample-take-list__playhead"
          x1={playheadFraction * peaks.length}
          x2={playheadFraction * peaks.length}
          y1={0}
          y2={100}
        />
      )}
    </svg>
  )
}
