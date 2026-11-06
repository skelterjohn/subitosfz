// The "sample drawer" is purely a filesystem diff: any .wav sitting in the
// project directory that no region in the loaded instrument references yet.
// No separate tracked state - the directory listing and the instrument are
// both already available, so this just re-derives the diff from them.
import type { Instrument } from './instrument'

export interface DrawerChunk {
  // Flat filename, relative to the .sfz's own directory - same convention
  // RegionInfo.samplePath already uses.
  fileName: string
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export function unassignedChunks(instrument: Instrument, dirEntries: string[]): DrawerChunk[] {
  const referenced = new Set<string>()
  for (const cell of instrument.cells) {
    for (const take of cell.samples) {
      for (const region of take.regions) {
        referenced.add(normalizePath(region.samplePath))
      }
    }
  }

  return dirEntries
    .filter((name) => /\.wav$/i.test(name))
    .filter((name) => !referenced.has(normalizePath(name)))
    .map((fileName) => ({ fileName }))
}
