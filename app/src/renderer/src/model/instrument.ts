// Core data model for the instrument grid: note x articulation x velocity
// layer, as described in docs/design.md.

export type Axis = 'note' | 'articulation' | 'velocity'

// note and velocity are both continuous ranges (MIDI key 0-127, MIDI
// velocity 0-127) that need overlap-aware segmentation and containment
// matching; articulation is the only genuinely discrete axis.
export type RangeAxis = 'note' | 'velocity'

export function isRangeAxis(axis: Axis): axis is RangeAxis {
  return axis === 'note' || axis === 'velocity'
}

export interface AxisValue {
  id: string
  label: string
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function midiToName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

// A single opcode as it literally appears in the file (after global/master/
// group cascading) - name and value are exactly the parsed text, not
// reinterpreted. There's no fixed opcode whitelist: SFZ has hundreds of
// possible opcodes, so a take carries whatever its region actually has.
export interface OpcodeEntry {
  name: string
  value: string
  // True if this came from <global>/<master>/<group> rather than being set
  // directly on this <region> - i.e. whether you'd have to look above this
  // specific region in the file to find it.
  isGlobal: boolean
}

// One literal <region> within a take - a stereo pair has two of these (L
// and R are distinct real files with their own pan etc.), most takes have
// just one.
export interface RegionInfo {
  // Relative to the .sfz file's own directory (same convention the file
  // itself uses for sample=).
  samplePath: string
  opcodes: OpcodeEntry[]
}

// One distinct recorded sound (round-robin/random-slot take, or a
// stereo-split region pair counted once) within a cell. "One sound" isn't
// "one file" - see RegionInfo.
export interface TakeInfo {
  regions: RegionInfo[]
}

// One recorded sound. loKey/hiKey and loVel/hiVel are the full key and
// velocity ranges it covers (what the grid stretches/matches it across);
// note is just its recorded anchor pitch - loKey <= note <= hiKey in
// well-formed data, but a cell can still be *selected* for a note outside
// that equality via pitch-shift coverage (see cellCoversPoint).
// Plain array, not a lookup map: with spanning/overlapping cells, "look up
// the cell at this exact row" no longer makes sense - the UI filters/scans
// this list instead.
export interface CellRecord {
  note: string
  articulation: string
  loKey: number
  hiKey: number
  loVel: number
  hiVel: number
  // One entry per distinct recorded sound (take) in this cell. Length is
  // the real take count - no separate count field to keep in sync with it.
  samples: TakeInfo[]
}

export function cellRange(cell: CellRecord, axis: RangeAxis): [number, number] {
  return axis === 'note' ? [cell.loKey, cell.hiKey] : [cell.loVel, cell.hiVel]
}

// Everything the grid needs to render: the three axes' actual values, and
// the cells to place within them. noteAxis/velocityAxis are only used as
// convenience defaults (initial pivot value, emptiness check) - the grid
// itself derives the real displayed ranges dynamically per pivot state.
export interface Instrument {
  noteAxis: AxisValue[]
  articulationAxis: AxisValue[]
  velocityAxis: AxisValue[]
  cells: CellRecord[]
}

export function axisValues(instrument: Instrument, axis: Axis): AxisValue[] {
  switch (axis) {
    case 'note':
      return instrument.noteAxis
    case 'articulation':
      return instrument.articulationAxis
    case 'velocity':
      return instrument.velocityAxis
  }
}

// Shown before any .sfz has been opened - genuinely empty, not padded out
// with a default range/articulation/velocity set.
export function emptyInstrument(): Instrument {
  return { noteAxis: [], articulationAxis: [], velocityAxis: [], cells: [] }
}

// Shape returned by POST /sfz/parse.
export interface ParsedSfzResponse {
  notes: number[]
  articulations: Array<{ id: string; label: string }>
  velocities: Array<{ lovel: number; hivel: number }>
  cells: Array<{
    note: number
    articulation: string
    loKey: number
    hiKey: number
    loVel: number
    hiVel: number
    samples: TakeInfo[]
  }>
}

export function instrumentFromParsedSfz(parsed: ParsedSfzResponse): Instrument {
  const noteAxis: AxisValue[] = [...parsed.notes]
    .sort((a, b) => b - a) // high to low, so the grid reads top-to-bottom like a keyboard
    .map((midi) => ({ id: String(midi), label: midiToName(midi) }))

  const articulationAxis: AxisValue[] = parsed.articulations.map((a) => ({
    id: a.id,
    label: a.label
  }))

  // id is the bucket's own lovel, a real velocity number usable directly
  // for range-containment pivoting - not an index into this list anymore.
  const velocityAxis: AxisValue[] = parsed.velocities.map((v) => ({
    id: String(v.lovel),
    label: `${v.lovel}-${v.hivel}`
  }))

  const cells: CellRecord[] = parsed.cells.map((c) => ({
    note: String(c.note),
    articulation: c.articulation,
    loKey: c.loKey,
    hiKey: c.hiKey,
    loVel: c.loVel,
    hiVel: c.hiVel,
    samples: c.samples
  }))

  return { noteAxis, articulationAxis, velocityAxis, cells }
}
