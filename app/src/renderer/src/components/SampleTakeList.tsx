import { useEffect, useMemo, useRef, useState } from 'react'
import type { CellRecord, OpcodeEntry, RegionInfo, TakeInfo } from '../model/instrument'
import './SampleTakeList.css'

interface Props {
  cell: CellRecord | null
  sfzFilePath: string | null
  onSetOpcode: (regionIndex: number, name: string, value: string) => Promise<void>
  // Writes into the file's <global> section rather than one region - see
  // App.tsx/sfz_write.rs's set_global_opcode. Threaded all the way down to
  // RegionRow's always-visible "global" section, same as onSetOpcode is for
  // its "cell" section.
  onSetGlobalOpcode: (name: string, value: string) => Promise<void>
  onDeleteRegion: (regionIndex: number) => Promise<void>
  // Converts every take in the current cell (whatever that is, from the
  // caller's own perspective - this component doesn't pass anything back,
  // the cell it's already been given is the group) into random-selection
  // round-robin via lorand/hirand - not something this component computes
  // itself, see App.tsx's splitCellIntoRoundRobin.
  onSplitRoundRobin: () => Promise<void>
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

interface FlatRegion {
  key: string
  region: RegionInfo
}

// Keyed by regionIndex (stable across re-parses - see model/instrument.ts)
// rather than a samplePath-based composite: editing a region's own sample=
// is in scope for this app, and a samplePath-based key would spuriously
// remount the row (closing whatever opcode panel the user was just editing
// in) the moment that edit lands.
function flattenRegions(cell: CellRecord): FlatRegion[] {
  const out: FlatRegion[] = []
  cell.samples.forEach((take) => {
    take.regions.forEach((region) => {
      out.push({ key: String(region.regionIndex), region })
    })
  })
  return out
}

// Every opcode write (including a loop-point drag) round-trips through the
// backend and comes back as a freshly re-parsed `instrument`, so `cell`
// gets a brand-new object identity on every edit even when the edit itself
// only touched one opcode on one region - the actual decoded audio is
// untouched. Keying the reload effect below off this fingerprint instead
// of `cell` directly means the heavy reset (close the AudioContext, drop
// every decoded buffer, re-fetch and re-decode every sample from disk) only
// runs when the real region/file set changes, not on every opcode edit -
// that full reset is what was showing up as a flash/redraw on each edit.
function regionFingerprint(cell: CellRecord | null, sfzFilePath: string | null): string {
  if (!cell || !sfzFilePath) return ''
  return sfzFilePath + '|' + flattenRegions(cell).map((r) => `${r.key}:${r.region.samplePath}`).join(',')
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

// Exactly what defines a cell's span (key range, velocity range, and the
// articulation it's gated on) - the opcode panel's "cell" section holds
// ONLY these, in this fixed read order, never anything else; every other
// local opcode (pan, tune, loop points, the sample path itself...) is
// per-sample, not cell-defining, and lives in its own "sample" section
// instead (see RegionRow).
const REGION_CRITERIA_OPCODES = ['lokey', 'hikey', 'lovel', 'hivel', 'sw_last', 'sw_label']

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
export default function SampleTakeList({
  cell,
  sfzFilePath,
  onSetOpcode,
  onSetGlobalOpcode,
  onDeleteRegion,
  onSplitRoundRobin
}: Props): React.JSX.Element {
  const [regionStates, setRegionStates] = useState<Record<string, RegionState>>({})
  // Shared across every take row in this cell (not per-row) - they're all
  // really the same action (split THIS cell), just duplicated onto every
  // row's own button for convenience, so one in-flight request should
  // disable all of them rather than just the one that was clicked.
  const [splitting, setSplitting] = useState(false)

  async function handleSplit(): Promise<void> {
    if (splitting) return
    setSplitting(true)
    try {
      await onSplitRoundRobin()
    } catch (err) {
      window.alert(`Failed to split into round-robin: ${String(err)}`)
    } finally {
      setSplitting(false)
    }
  }
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

  // Deliberately NOT `[cell, sfzFilePath]` - see regionFingerprint above.
  // The effect body below still reads the latest `cell`/`sfzFilePath` from
  // this render's closure; the fingerprint only controls whether it reruns.
  const fingerprint = useMemo(() => regionFingerprint(cell, sfzFilePath), [cell, sfzFilePath])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])

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
    take.regions.forEach((region) => {
      const key = String(region.regionIndex)
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
            key={take.regions[0]?.regionIndex ?? i}
            takeIndex={i}
            take={take}
            regionStates={regionStates}
            playheads={playheads}
            onPlayRegion={playRegion}
            onPlayTake={playTake}
            onSetOpcode={onSetOpcode}
            onSetGlobalOpcode={onSetGlobalOpcode}
            onDeleteRegion={onDeleteRegion}
            // True only while some take still bundles more than one region
            // together (no lorand/hirand yet distinguishing them - see
            // App.tsx's splitCellIntoRoundRobin). Once every take has
            // exactly one region, the cell's already fully split - there's
            // nothing left to break apart, even though the cell as a whole
            // may still have several takes/regions in it.
            canSplit={cell.samples.some((t) => t.regions.length > 1)}
            splitting={splitting}
            onSplit={handleSplit}
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
  onSetOpcode: (regionIndex: number, name: string, value: string) => Promise<void>
  onSetGlobalOpcode: (name: string, value: string) => Promise<void>
  onDeleteRegion: (regionIndex: number) => Promise<void>
  // Same action/state duplicated onto every take row in the cell - see
  // SampleTakeList's own handleSplit for why this isn't take-specific.
  canSplit: boolean
  splitting: boolean
  onSplit: () => void
}

function TakeItem({
  takeIndex,
  take,
  regionStates,
  playheads,
  onPlayRegion,
  onPlayTake,
  onSetOpcode,
  onSetGlobalOpcode,
  onDeleteRegion,
  canSplit,
  splitting,
  onSplit
}: TakeItemProps): React.JSX.Element {
  const [holdSeconds, setHoldSeconds] = useState(DEFAULT_HOLD_SECONDS)
  // Which regions' opcode panels are unfolded - lifted up from each row
  // (rather than local state there) so a loop-block drag can tell whether
  // every region in this take is folded closed or not; see commitLoopEdit.
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  function toggleOpen(key: string): void {
    setOpenKeys((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const anyReady = take.regions.some((region) => {
    return regionStates[String(region.regionIndex)]?.status === 'ready'
  })
  // Regions in a take play simultaneously (same note-on), so their
  // waveforms should share one timeline - the longest region fills the
  // box, shorter ones occupy a proportionally smaller slice of it, and a
  // playhead at a given moment in real time lands at the same x in every
  // region's row rather than each racing to its own right edge.
  const takeMaxDurationSec = Math.max(
    0,
    ...take.regions.map((region) => {
      const s = regionStates[String(region.regionIndex)]
      return s?.status === 'ready' ? s.durationSec : 0
    })
  )

  // A loop-block drag on one region's waveform commits here. A take's
  // regions all play together on one note-on, so while every one of them
  // is folded closed they're treated as a single unit - the edit fans out
  // to all of them. The moment any region is opened for individual
  // inspection, a drag targets just the region actually being dragged
  // (opening a row is the signal that this one is being worked on alone).
  // Each sibling's own opcode value is computed independently off its own
  // nativeSampleRate/current loop range, not copied verbatim - a stereo
  // pair's L/R files could in principle differ. A sibling with no loop
  // range of its own is left alone - there's no edge on it to move.
  function commitLoopEdit(sourceKey: string, edge: LoopEdge, edgeSec: number): Promise<void> {
    const allClosed = take.regions.every((r) => !openKeys.has(String(r.regionIndex)))
    const targets = allClosed
      ? take.regions
      : take.regions.filter((r) => String(r.regionIndex) === sourceKey)
    return Promise.all(
      targets.map((r) => {
        const s = regionStates[String(r.regionIndex)]
        if (s?.status !== 'ready') return Promise.resolve()
        const loopRange = regionLoopRangeSec(r, s.nativeSampleRate)
        if (!loopRange) return Promise.resolve()
        const fileFrames = Math.max(0, Math.round(s.durationSec * s.nativeSampleRate) - 1)
        const frames = Math.round(edgeSec * s.nativeSampleRate)
        if (edge === 'start') {
          const endFrames = Math.round(loopRange.end * s.nativeSampleRate)
          const clamped = Math.max(0, Math.min(frames, endFrames - 1, fileFrames))
          return onSetOpcode(r.regionIndex, 'loop_start', String(clamped))
        }
        const startFrames = Math.round(loopRange.start * s.nativeSampleRate)
        const clamped = Math.max(startFrames + 1, Math.min(frames, fileFrames))
        return onSetOpcode(r.regionIndex, 'loop_end', String(clamped))
      })
    ).then(() => undefined)
  }

  return (
    <div className="sample-take-list__item">
      <div className="sample-take-list__regions">
        {take.regions.map((region) => {
          // Must match flattenRegions' key format exactly - this is how a
          // row finds its own decoded buffer/peaks in the shared state above.
          const key = String(region.regionIndex)
          return (
            <RegionRow
              key={key}
              region={region}
              state={regionStates[key]}
              takeMaxDurationSec={takeMaxDurationSec}
              playheadPositionSec={playheads[key]}
              isOpen={openKeys.has(key)}
              onToggleOpen={() => toggleOpen(key)}
              onPlay={() => onPlayRegion(key, region)}
              onSetOpcode={onSetOpcode}
              onSetGlobalOpcode={onSetGlobalOpcode}
              onCommitLoopEdit={(edge, edgeSec) => commitLoopEdit(key, edge, edgeSec)}
              onDeleteRegion={onDeleteRegion}
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
            aria-label="Seconds to hold this note"
            title="Seconds to hold this note"
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
        {/* Acts on every region in the cell, not just this row - duplicated
            onto every row purely so it's reachable from wherever the user
            already is, not because this one take is special. See
            App.tsx's splitCellIntoRoundRobin for why this is per-region
            rather than per-take. Hidden rather than just disabled for a
            single-region cell - there's nothing to round-robin, so the
            control itself isn't relevant, not merely unavailable right now. */}
        {canSplit && (
          <button
            type="button"
            className="sample-take-list__split"
            onClick={onSplit}
            disabled={splitting}
            title="Split every region in this cell into round-robin (random selection via lorand/hirand)"
            aria-label="Split into round-robin"
          >
            split
          </button>
        )}
      </div>
    </div>
  )
}

interface RegionRowProps {
  region: RegionInfo
  state: RegionState | undefined
  takeMaxDurationSec: number
  playheadPositionSec: number | undefined
  isOpen: boolean
  onToggleOpen: () => void
  onPlay: () => void
  onSetOpcode: (regionIndex: number, name: string, value: string) => Promise<void>
  onSetGlobalOpcode: (name: string, value: string) => Promise<void>
  onCommitLoopEdit: (edge: LoopEdge, edgeSec: number) => Promise<void>
  onDeleteRegion: (regionIndex: number) => Promise<void>
}

function RegionRow({
  region,
  state,
  takeMaxDurationSec,
  playheadPositionSec,
  isOpen,
  onToggleOpen,
  onPlay,
  onSetOpcode,
  onSetGlobalOpcode,
  onCommitLoopEdit,
  onDeleteRegion
}: RegionRowProps): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  // Bound to this region, so OpcodeRow/the add-opcode control below only
  // ever need to know a bare (name, value) pair.
  const setOpcode = (name: string, value: string): Promise<void> =>
    onSetOpcode(region.regionIndex, name, value)
  const samplePath = region.samplePath
  const fileName = samplePath.split(/[/\\]/).pop() ?? samplePath
  const isReady = state?.status === 'ready'

  // Removes this region only - a different region that happens to overlap
  // the same cell (see InstrumentGrid's overlap handling) is untouched,
  // since deletion targets one region's own regionIndex, not the cell as a
  // whole. Irreversible (like the drawer's delete-from-disk), so confirmed
  // the same way - this row unmounts on success as the region disappears
  // from `cell.samples`, so there's no "done" state to reset afterward.
  async function handleDelete(): Promise<void> {
    if (deleting) return
    if (!window.confirm(`Delete this region ("${fileName}") from the instrument? This can't be undone.`)) {
      return
    }
    setDeleting(true)
    try {
      await onDeleteRegion(region.regionIndex)
    } catch (err) {
      window.alert(`Failed to delete region: ${String(err)}`)
      setDeleting(false)
    }
  }
  // Pulled out into their own section regardless of global/local status (in
  // practice always local - these are what make one region selection-
  // distinct from another, so they're almost never inherited) rather than
  // left to sort wherever they happen to fall among the rest.
  const criteriaOpcodes = REGION_CRITERIA_OPCODES.map((name) =>
    region.opcodes.find((op) => op.name === name)
  ).filter((op): op is OpcodeEntry => op !== undefined)
  const remainingOpcodes = region.opcodes.filter((op) => !REGION_CRITERIA_OPCODES.includes(op.name))
  const globalOpcodes = remainingOpcodes.filter((op) => op.isGlobal)
  const localOpcodes = remainingOpcodes.filter((op) => !op.isGlobal)

  return (
    <div className="sample-take-list__region">
      <div className="sample-take-list__row">
        <button
          type="button"
          className="sample-take-list__toggle"
          onClick={onToggleOpen}
          aria-label={isOpen ? 'Hide opcodes' : 'Show opcodes'}
        >
          {isOpen ? '▾' : '▸'}
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
              onCommitLoopEdit={onCommitLoopEdit}
            />
          )}
        </div>
      </div>
      {isOpen && (
        <div className="sample-take-list__opcodes">
          {/* This region's own play/delete controls - only reachable once
              unfolded, since the folded row relies on the take's single
              combined play button instead. */}
          <div className="sample-take-list__region-actions">
            <button
              type="button"
              className="sample-take-list__play"
              onClick={onPlay}
              disabled={!isReady}
              aria-label="Play this sample"
            >
              ▶
            </button>
            <button
              type="button"
              className="sample-take-list__delete-region"
              onClick={handleDelete}
              disabled={deleting}
              aria-label="Delete this region"
              title="Delete this region"
            >
              <TrashIcon />
            </button>
          </div>
          {/* "global" writes into the file's <global> section (every
              region in the file, not just this one - see App.tsx's
              setGlobalOpcode). "cell" is read/edit only and holds ONLY the
              opcodes that define this cell's span (REGION_CRITERIA_OPCODES)
              - nothing else belongs here, so there's no add control for
              it; those six are always written together whenever a region
              is created (see sfz_write.rs's append_region) and edited as a
              group from SampleEditorPanel, not added one at a time here.
              Everything else local to this one region (pan, tune, loop
              points, the sample path itself...) gets no rail of its own -
              same flush-left, unlabeled treatment it always had - with one
              shared add control below for it. */}
          <div className="sample-take-list__opcode-group">
            <span className="sample-take-list__opcode-rail">global</span>
            <div className="sample-take-list__opcode-rows">
              {globalOpcodes.map((op) => (
                <OpcodeRow key={op.name} op={op} onSetOpcode={setOpcode} />
              ))}
              <AddOpcodeControl onSetOpcode={onSetGlobalOpcode} />
            </div>
          </div>
          <div className="sample-take-list__opcode-group">
            <span className="sample-take-list__opcode-rail">cell</span>
            <div className="sample-take-list__opcode-rows">
              {criteriaOpcodes.map((op) => (
                <OpcodeRow key={op.name} op={op} onSetOpcode={setOpcode} />
              ))}
            </div>
          </div>
          {localOpcodes.length > 0 && (
            <div className="sample-take-list__opcode-rows">
              {localOpcodes.map((op) => (
                <OpcodeRow key={op.name} op={op} onSetOpcode={setOpcode} />
              ))}
            </div>
          )}
          <AddOpcodeControl onSetOpcode={setOpcode} />
        </div>
      )}
    </div>
  )
}

interface OpcodeRowProps {
  op: OpcodeEntry
  onSetOpcode: (name: string, value: string) => Promise<void>
}

// Click the value to edit it in place - standard inline-edit pattern (click
// -> input, Enter/blur commits, Escape cancels), new to this app. Editing
// and adding an opcode are the same backend call (see App.tsx/sfz_write.rs
// - a region's own opcode always wins over an inherited one regardless of
// file position), so clicking an inherited ("global") value's text and
// typing a new one correctly creates a local override, with no special
// case needed here.
function OpcodeRow({ op, onSetOpcode }: OpcodeRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftValue, setDraftValue] = useState(op.value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set by Escape just before it blurs the input, so the blur handler's
  // commit is skipped instead of re-saving the value Escape just reverted.
  const cancelingRef = useRef(false)

  function startEditing(): void {
    setDraftValue(op.value)
    setError(null)
    setEditing(true)
  }

  function cancel(): void {
    cancelingRef.current = true
    setDraftValue(op.value)
    setEditing(false)
  }

  async function commit(): Promise<void> {
    if (cancelingRef.current) {
      cancelingRef.current = false
      return
    }
    if (draftValue === op.value) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSetOpcode(op.name, draftValue)
      setEditing(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="sample-take-list__opcode">
      <span className="sample-take-list__opcode-name">{op.name}</span>
      {editing ? (
        <input
          type="text"
          className="sample-take-list__opcode-input"
          value={draftValue}
          disabled={saving}
          autoFocus
          onChange={(e) => setDraftValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              cancel()
              e.currentTarget.blur()
            }
          }}
        />
      ) : (
        <span
          className="sample-take-list__opcode-value sample-take-list__opcode-value--editable"
          onClick={startEditing}
          title="Click to edit"
        >
          {op.value}
        </span>
      )}
      {error && <span className="sample-take-list__opcode-error">{error}</span>}
    </div>
  )
}

// Rendered once per scope (global, cell) rather than once for the whole
// panel - which callback it's given determines which scope the new opcode
// actually lands in. Clicking it reveals a name+value form, submitting via
// the same callback path used for editing an existing value.
function AddOpcodeControl({
  onSetOpcode
}: {
  onSetOpcode: (name: string, value: string) => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close(): void {
    setOpen(false)
    setName('')
    setValue('')
    setError(null)
  }

  async function submit(): Promise<void> {
    const trimmedName = name.trim()
    if (!trimmedName || !value) return
    setSaving(true)
    setError(null)
    try {
      await onSetOpcode(trimmedName, value)
      close()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="sample-take-list__add-opcode-toggle"
        onClick={() => setOpen(true)}
        aria-label="Add a new opcode"
        title="Add a new opcode"
      >
        +
      </button>
    )
  }

  return (
    <div className="sample-take-list__add-opcode-form">
      <div className="sample-take-list__add-opcode-row">
        <input
          type="text"
          placeholder="opcode"
          value={name}
          disabled={saving}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="value"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') close()
          }}
        />
        <button
          type="button"
          className="sample-take-list__add-opcode-confirm"
          onClick={submit}
          disabled={saving || !name.trim() || !value}
          aria-label="Save new opcode"
        >
          ✓
        </button>
        <button
          type="button"
          className="sample-take-list__add-opcode-cancel"
          onClick={close}
          disabled={saving}
          aria-label="Cancel"
        >
          ×
        </button>
      </div>
      {error && <span className="sample-take-list__opcode-error">{error}</span>}
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
  // Fires once, on release, with which edge moved and its seconds position
  // in this take's shared timeline - the caller (TakeItem) decides whether
  // that fans out to every region in the take or just this one, and does
  // the seconds->frames conversion itself (each region can have its own
  // nativeSampleRate), so this component only ever deals in geometry.
  onCommitLoopEdit: (edge: LoopEdge, edgeSec: number) => Promise<void>
}

// Which edge of the loop block a drag/click is acting on - null means
// inside the block (or there's no block to act on), where it's a no-op.
type LoopEdge = 'start' | 'end'

function Waveform({
  peaks,
  durationSec,
  takeMaxDurationSec,
  loopRangeSec,
  playheadPositionSec,
  onCommitLoopEdit
}: WaveformProps): React.JSX.Element {
  // Seconds -> viewBox x units, shared across every region in the take so
  // a shorter region's bars/loop-box/playhead all land at the same x a
  // longer sibling's would at that same moment, instead of each being
  // independently stretched to fill the full box width.
  const scale = takeMaxDurationSec > 0 ? PEAK_BARS / takeMaxDurationSec : 0
  const barDurationSec = peaks.length > 0 ? durationSec / peaks.length : 0
  const svgRef = useRef<SVGSVGElement | null>(null)
  // Which edge is actively being dragged, and its live (uncommitted)
  // seconds position - tracked locally so the box follows the cursor every
  // frame without round-tripping onSetOpcode on every pointermove. The
  // actual opcode write happens once, on release.
  const [dragEdge, setDragEdge] = useState<LoopEdge | null>(null)
  const [dragSec, setDragSec] = useState(0)

  function clientXToSec(clientX: number): number {
    const svg = svgRef.current
    if (!svg || scale === 0) return 0
    const rect = svg.getBoundingClientRect()
    const frac = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0
    return (frac * PEAK_BARS) / scale
  }

  // Hover-only cursor feedback (no re-render) - col-resize outside the
  // current block, where a click/drag would do something, default inside
  // it or when there's no block at all.
  function updateHoverCursor(clientX: number): void {
    const svg = svgRef.current
    if (!svg) return
    if (!loopRangeSec) {
      svg.style.cursor = 'default'
      return
    }
    const sec = clientXToSec(clientX)
    svg.style.cursor = sec < loopRangeSec.start || sec > loopRangeSec.end ? 'col-resize' : 'default'
  }

  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>): void {
    if (!loopRangeSec) return
    const sec = clientXToSec(e.clientX)
    const edge: LoopEdge | null =
      sec < loopRangeSec.start ? 'start' : sec > loopRangeSec.end ? 'end' : null
    if (!edge) return
    setDragEdge(edge)
    setDragSec(sec)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>): void {
    if (dragEdge) {
      setDragSec(clientXToSec(e.clientX))
    } else {
      updateHoverCursor(e.clientX)
    }
  }

  async function handlePointerUp(e: React.PointerEvent<SVGSVGElement>): Promise<void> {
    const edge = dragEdge
    const edgeSec = dragSec
    setDragEdge(null)
    if (!edge || !loopRangeSec) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    await onCommitLoopEdit(edge, edgeSec)
  }

  // What's actually drawn for the loop box - the live drag position while
  // dragging, the last-committed opcode values otherwise.
  const displayLoopRange =
    dragEdge && loopRangeSec
      ? dragEdge === 'start'
        ? { start: Math.min(dragSec, loopRangeSec.end), end: loopRangeSec.end }
        : { start: loopRangeSec.start, end: Math.max(dragSec, loopRangeSec.start) }
      : loopRangeSec

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${PEAK_BARS} 100`}
      preserveAspectRatio="none"
      className="sample-take-list__svg"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Drawn first (behind the bars) - loop_start/loop_end's current
          range. Clicking/dragging left of it moves loop_start, right of it
          moves loop_end; clicking inside the block does nothing. */}
      {displayLoopRange && (
        <rect
          className="sample-take-list__loop-region"
          x={displayLoopRange.start * scale}
          y={0}
          width={(displayLoopRange.end - displayLoopRange.start) * scale}
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
