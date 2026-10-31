// Core data model for the instrument grid: note x articulation x velocity
// layer, as described in docs/design.md.

export type Axis = 'note' | 'articulation' | 'velocity'

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

// One recorded sound. loKey/hiKey is the full range of keys it covers via
// pitch-shifting (what the grid stretches it across), while note is just
// its recorded anchor pitch - loKey <= note <= hiKey in well-formed data.
// Plain array, not a lookup map: with spanning/overlapping cells, "look up
// the cell at this exact row" no longer makes sense - the UI filters/scans
// this list instead.
export interface CellRecord {
  note: string
  articulation: string
  velocity: string
  loKey: number
  hiKey: number
  takeCount: number
}

// Everything the grid needs to render: the three axes' actual values, and
// the cells to place within them.
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
    velocityIndex: number
    takeCount: number
    loKey: number
    hiKey: number
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

  const velocityAxis: AxisValue[] = parsed.velocities.map((v, i) => ({
    id: String(i),
    label: `${v.lovel}-${v.hivel}`
  }))

  const cells: CellRecord[] = parsed.cells.map((c) => ({
    note: String(c.note),
    articulation: c.articulation,
    velocity: String(c.velocityIndex),
    loKey: c.loKey,
    hiKey: c.hiKey,
    takeCount: c.takeCount
  }))

  return { noteAxis, articulationAxis, velocityAxis, cells }
}
