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
  | { status: 'ready'; peaks: Peak[]; durationSec: number; nativeSampleRate: number }

// Reads just the sample rate out of a RIFF/WAVE file's 'fmt ' chunk,
// independent of whatever rate decodeAudioData resamples to on the way in.
// loop_start/loop_end in the sfz are sample-frame offsets at the file's OWN
// rate, and Chromium silently resamples on decode whenever that differs
// from the output device's rate (e.g. these files are 44100Hz, but a
// 48000Hz audio device makes decodeAudioData hand back a 48000Hz buffer) -
// dividing the raw opcode values by the decoded buffer's sampleRate would
// scale every loop point wrong by that same ratio. Returns null (falling
// back to the decoded rate) for anything that isn't a plain RIFF/WAVE file.
function parseWavSampleRate(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ' && offset + 16 <= bytes.length) {
      return view.getUint32(offset + 12, true)
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

// What a currently-sounding region needs in order to compute, on demand,
// where its playhead currently sits - recomputed each animation frame
// rather than stored as a moving number, since "now" only exists as
// ctx.currentTime at read time. durationSec is the buffer's own natural
// duration - the cap on posSec below. It is NOT how long this registration
// stays alive: a looping region keeps looping right up until the gain
// envelope's release ramp reaches silence and the source is hard-stopped,
// which is usually well past durationSec - that real total is
// scheduledEndSec.
interface PlaybackInfo {
  startAt: number
  durationSec: number
  loopStartSec: number | null
  loopEndSec: number | null
  scheduledEndSec: number
}

// Seconds into this region's own buffer the playhead currently sits at, or
// null once playback has finished (or hasn't started yet) - null means
// "don't draw a line" to the caller. Deliberately NOT normalized into a
// 0..1 fraction here: every region in a take shares the same startAt, so
// this raw seconds value is what stays comparable across regions of
// different lengths within one take - the rendering side (Waveform) is
// what turns it into an x-coordinate, against a shared denominator (the
// take's longest region) rather than each region's own duration, so
// playheads for a mismatched-length stereo pair etc. stay aligned instead
// of each racing to its own finish line. The source keeps looping all the
// way to scheduledEndSec now (the gain envelope, not a loop-disable
// switch, is what makes it fade out) so this is just the plain wraparound
// modulo for the whole active window, no separate "released" phase needed.
function playbackPositionSec(info: PlaybackInfo, now: number): number | null {
  const elapsed = now - info.startAt
  if (elapsed < 0 || elapsed > info.scheduledEndSec) return null
  let posSec = elapsed
  if (info.loopStartSec !== null && info.loopEndSec !== null && elapsed > info.loopStartSec) {
    const loopLen = info.loopEndSec - info.loopStartSec
    posSec = info.loopStartSec + ((elapsed - info.loopStartSec) % loopLen)
  }
  return Math.min(posSec, info.durationSec)
}

// ampeg_* opcodes, with the SFZ spec's own defaults for anything absent:
// no attack/hold/decay ramp (instant full volume), full sustain (no decay
// floor), instant release. sustain is a PERCENTAGE of full gain, not
// seconds, per spec.
interface AmpegEnvelope {
  attack: number
  hold: number
  decay: number
  sustainFrac: number
  release: number
}

function regionAmpeg(region: RegionInfo): AmpegEnvelope {
  const num = (name: string, fallback: number): number => {
    const raw = region.opcodes.find((op) => op.name === name)?.value
    const v = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(v) ? v : fallback
  }
  return {
    attack: Math.max(0, num('ampeg_attack', 0)),
    hold: Math.max(0, num('ampeg_hold', 0)),
    decay: Math.max(0, num('ampeg_decay', 0)),
    sustainFrac: Math.min(1, Math.max(0, num('ampeg_sustain', 100) / 100)),
    release: Math.max(0, num('ampeg_release', 0))
  }
}

// loop_start/loop_end are sample-frame offsets at the file's own native
// rate - converted to seconds here using that same native rate (not the
// decoded buffer's, possibly-resampled, rate) so this lines up with
// durationSec regardless of what the output device resampled to.
function regionLoopRangeSec(
  region: RegionInfo,
  nativeSampleRate: number
): { start: number; end: number } | null {
  const startFrames = Number(region.opcodes.find((op) => op.name === 'loop_start')?.value)
  const endFrames = Number(region.opcodes.find((op) => op.name === 'loop_end')?.value)
  if (!Number.isFinite(startFrames) || !Number.isFinite(endFrames) || endFrames <= startFrames) {
    return null
  }
  return { start: startFrames / nativeSampleRate, end: endFrames / nativeSampleRate }
}

function formatDuration(seconds: number): string {
  return `${seconds.toFixed(2)}s`
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
  // Seconds into each actively-sounding region's own buffer, not a 0..1
  // fraction - see playbackPositionSec for why.
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
      // we're actually past scheduledEndSec, NOT durationSec: while
      // looping, elapsed keeps growing well past durationSec (loop_end
      // commonly sits right at the file's natural end, so elapsed crosses
      // durationSec almost immediately after entering the loop, while the
      // AudioBufferSourceNode itself keeps looping for real independent of
      // this bookkeeping).
      if (elapsed > info.scheduledEndSec) {
        activePlaybackRef.current.delete(key)
        return
      }
      if (elapsed < 0) return
      const posSec = playbackPositionSec(info, now)
      if (posSec !== null) next[key] = posSec
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
          const nativeSampleRate = parseWavSampleRate(bytes)
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
              durationSec: audioBuffer.duration,
              nativeSampleRate: nativeSampleRate ?? audioBuffer.sampleRate
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
      scheduledEndSec: buffer.duration
    })
  }

  // Scheduled at the same future instant for every region in the take
  // rather than started back-to-back in a loop, so node-creation overhead
  // doesn't stagger the actual playback - this is what real SFZ playback
  // does too (one note-on fires every region sharing that sound identity).
  //
  // Simulates holding the note for holdSeconds then releasing it, the same
  // way a real synth voice works: each region's own loop_start/loop_end (if
  // present) keeps it sounding indefinitely regardless of how short the
  // file is, while a GainNode automates the real ampeg_attack/hold/decay/
  // sustain/release envelope on top - attack/hold/decay play out from
  // note-on, then holds at the sustain level until holdSeconds, then
  // releases to silence. cancelAndHoldAtTime handles releasing cleanly
  // from wherever the envelope actually is at that instant, even mid-ramp
  // (e.g. holdSeconds shorter than attack+hold+decay). The source is
  // hard-stopped once the release ramp reaches 0 - by then it's silent, so
  // there's no click, and no need to separately manage switching the loop
  // off and hoping there's enough of a file tail left to play into.
  function playTake(takeIndex: number, take: TakeInfo, holdSeconds: number): void {
    const ctx = audioCtxRef.current
    if (!ctx) return
    ctx.resume()
    const startAt = ctx.currentTime + 0.05
    take.regions.forEach((region, ri) => {
      const key = `${takeIndex}-${ri}-${region.samplePath}`
      const buffer = buffersRef.current.get(key)
      if (!buffer) return
      const state = regionStates[key]
      const nativeSampleRate = state?.status === 'ready' ? state.nativeSampleRate : buffer.sampleRate
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const gain = ctx.createGain()
      const panner = ctx.createStereoPanner()
      panner.pan.value = regionPan(region)
      source.connect(gain).connect(panner).connect(ctx.destination)

      const loopRange = regionLoopRangeSec(region, nativeSampleRate)
      let loopStartSec: number | null = null
      let loopEndSec: number | null = null
      if (loopRange) {
        loopStartSec = loopRange.start
        loopEndSec = loopRange.end
        source.loop = true
        source.loopStart = loopStartSec
        source.loopEnd = loopEndSec
      }

      const env = regionAmpeg(region)
      const attackEnd = startAt + env.attack
      const holdEnd = attackEnd + env.hold
      const decayEnd = holdEnd + env.decay
      gain.gain.setValueAtTime(0, startAt)
      gain.gain.linearRampToValueAtTime(1, attackEnd)
      gain.gain.setValueAtTime(1, holdEnd)
      gain.gain.linearRampToValueAtTime(env.sustainFrac, decayEnd)

      const releaseAt = Math.max(startAt, startAt + holdSeconds)
      gain.gain.cancelAndHoldAtTime(releaseAt)
      // A floor on the release ramp length, not a reinterpretation of the
      // opcode - release=0 is valid and means "as fast as possible", but a
      // literal zero-length ramp is a discontinuity that clicks.
      const releaseEnd = releaseAt + Math.max(env.release, 0.005)
      gain.gain.linearRampToValueAtTime(0, releaseEnd)

      source.start(startAt)
      source.stop(releaseEnd)

      registerPlayback(key, {
        startAt,
        durationSec: buffer.duration,
        loopStartSec,
        loopEndSec,
        scheduledEndSec: releaseEnd - startAt
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
  onPlayTake: (takeIndex: number, take: TakeInfo, holdSeconds: number) => void
}

function TakeItem({
  takeIndex,
  take,
  regionStates,
  playheads,
  onPlayRegion,
  onPlayTake
}: TakeItemProps): React.JSX.Element {
  const [holdSeconds, setHoldSeconds] = useState(DEFAULT_HOLD_SECONDS)
  const anyReady = take.regions.some((region, ri) => {
    const key = `${takeIndex}-${ri}-${region.samplePath}`
    return regionStates[key]?.status === 'ready'
  })
  // Regions in a take play simultaneously (same note-on), so their
  // waveforms should share one timeline - the longest region fills the
  // box, shorter ones occupy a proportionally smaller slice of it, and a
  // playhead at a given moment in real time lands at the same x in every
  // region's row rather than each racing to its own right edge.
  const takeMaxDurationSec = Math.max(
    0,
    ...take.regions.map((region, ri) => {
      const key = `${takeIndex}-${ri}-${region.samplePath}`
      const s = regionStates[key]
      return s?.status === 'ready' ? s.durationSec : 0
    })
  )

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
              takeMaxDurationSec={takeMaxDurationSec}
              playheadPositionSec={playheads[key]}
              onPlay={() => onPlayRegion(key, region)}
            />
          )
        })}
      </div>
      {/* The only play control visible on a folded row - an individual
          region's own play button only shows once its opcode panel is
          unfolded, so the collapsed view always has exactly one play
          button regardless of take size. The hold-duration field sits
          above it rather than beside it, so the pair still reads as one
          column at the fixed 48px width the row layout expects. */}
      <div className="sample-take-list__play-take-col">
        <div className="sample-take-list__hold-seconds-wrap">
          <input
            type="number"
            className="sample-take-list__hold-seconds"
            value={holdSeconds}
            min={0}
            step={0.5}
            onChange={(e) => setHoldSeconds(Math.max(0, Number(e.target.value) || 0))}
            aria-label="Seconds to hold this take's note before release"
            title="Seconds to hold this take's note before release (uses loop_ and ampeg_ opcodes)"
          />
          <span className="sample-take-list__hold-seconds-unit" aria-hidden="true">
            s
          </span>
        </div>
        <button
          type="button"
          className="sample-take-list__play-take"
          onClick={() => onPlayTake(takeIndex, take, holdSeconds)}
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
  takeMaxDurationSec: number
  playheadPositionSec: number | undefined
  onPlay: () => void
}

function RegionRow({
  region,
  state,
  takeMaxDurationSec,
  playheadPositionSec,
  onPlay
}: RegionRowProps): React.JSX.Element {
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
        <div className="sample-take-list__name" title={samplePath}>
          <span className="sample-take-list__filename">{fileName}</span>
          {state?.status === 'ready' && (
            <span className="sample-take-list__duration">{formatDuration(state.durationSec)}</span>
          )}
        </div>
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
              durationSec={state.durationSec}
              takeMaxDurationSec={Math.max(takeMaxDurationSec, state.durationSec)}
              loopRangeSec={regionLoopRangeSec(region, state.nativeSampleRate)}
              playheadPositionSec={playheadPositionSec}
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

// Default hold duration for the take-level play button, editable per take.
const DEFAULT_HOLD_SECONDS = 3

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
  durationSec: number
  // The longest region among this take's simultaneously-playing regions -
  // the shared denominator that keeps a shorter region's waveform (and its
  // playhead) scaled against the same timeline as its longer siblings,
  // rather than each stretching to fill its own box regardless of length.
  // Equals durationSec itself for the common single-region/equal-length
  // case, which keeps this pixel-identical to the old per-region scaling.
  takeMaxDurationSec: number
  loopRangeSec: { start: number; end: number } | null
  playheadPositionSec: number | undefined
}

function Waveform({
  peaks,
  durationSec,
  takeMaxDurationSec,
  loopRangeSec,
  playheadPositionSec
}: WaveformProps): React.JSX.Element {
  // Seconds -> viewBox x units, shared across every region in the take so
  // a shorter region's bars/loop-box/playhead all land at the same x a
  // longer sibling's would at that same moment, instead of each being
  // independently stretched to fill the full box width.
  const scale = takeMaxDurationSec > 0 ? PEAK_BARS / takeMaxDurationSec : 0
  const barDurationSec = peaks.length > 0 ? durationSec / peaks.length : 0

  return (
    <svg
      viewBox={`0 0 ${PEAK_BARS} 100`}
      preserveAspectRatio="none"
      className="sample-take-list__svg"
    >
      {/* Drawn first (behind the bars) - just a reference for where
          loop_start/loop_end currently sit, not yet editable. */}
      {loopRangeSec && (
        <rect
          className="sample-take-list__loop-region"
          x={loopRangeSec.start * scale}
          y={0}
          width={(loopRangeSec.end - loopRangeSec.start) * scale}
          height={100}
        />
      )}
      {peaks.map(([min, max], i) => {
        const top = 50 - max * 50
        const bottom = 50 - min * 50
        const height = Math.max(1, bottom - top)
        return (
          <rect
            key={i}
            x={i * barDurationSec * scale}
            y={top}
            width={Math.max(barDurationSec * scale, 0.5)}
            height={height}
          />
        )
      })}
      {/* Drawn last (on top of the bars) - this is a live position, not a
          fixed reference like the loop-region rect above. */}
      {playheadPositionSec !== undefined && (
        <line
          className="sample-take-list__playhead"
          x1={playheadPositionSec * scale}
          x2={playheadPositionSec * scale}
          y1={0}
          y2={100}
        />
      )}
    </svg>
  )
}
