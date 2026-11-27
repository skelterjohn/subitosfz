import { useMemo, useState } from 'react'
import { fuzzyMatchIndices, OPCODE_REFERENCE, type OpcodeDoc } from '../model/opcodeReference'
import './OpcodeReferenceWindow.css'

const NO_MATCH_INDICES = new Set<number>()

interface MatchedOpcode {
  op: OpcodeDoc
  nameIndices: Set<number>
  descriptionIndices: Set<number>
}

// Renders `text` with every index in `indices` bolded - the matched
// characters of a fuzzy subsequence match aren't necessarily contiguous
// (see fuzzyMatchIndices), so this walks the string in runs of
// matched/unmatched characters rather than assuming one highlighted span.
function Highlighted({ text, indices }: { text: string; indices: Set<number> }): React.JSX.Element {
  if (indices.size === 0) return <>{text}</>
  const runs: React.ReactNode[] = []
  let i = 0
  while (i < text.length) {
    const isMatch = indices.has(i)
    let j = i + 1
    while (j < text.length && indices.has(j) === isMatch) j++
    const chunk = text.slice(i, j)
    runs.push(isMatch ? <b key={i}>{chunk}</b> : chunk)
    i = j
  }
  return <>{runs}</>
}

// The whole page for the "SFZ opcode information..." window (see main/index.ts's
// createOpcodesWindow and main.tsx's hash routing) - a separate top-level
// OS window rather than a modal, so it can stay open and be referred back
// to while editing opcodes in the main window. Searches both the opcode
// name and its description, since a user hunting for "loop" or "velocity"
// may not know the exact opcode name yet.
export default function OpcodeReferenceWindow(): React.JSX.Element {
  const [query, setQuery] = useState('')

  // Name matches rank above description-only matches (each group keeping
  // its own alphabetical order) - searching "loop" should surface loop_mode/
  // loop_start/loop_end before the handful of unrelated opcodes that merely
  // mention looping in passing (e.g. amp_veltrack's own description).
  const matched = useMemo<MatchedOpcode[]>(() => {
    if (!query.trim()) {
      return OPCODE_REFERENCE.map((op) => ({
        op,
        nameIndices: NO_MATCH_INDICES,
        descriptionIndices: NO_MATCH_INDICES
      }))
    }
    const nameMatches: MatchedOpcode[] = []
    const descriptionOnlyMatches: MatchedOpcode[] = []
    for (const op of OPCODE_REFERENCE) {
      const nameIndices = fuzzyMatchIndices(query, op.name)
      if (nameIndices) {
        const descriptionIndices = fuzzyMatchIndices(query, op.description) ?? NO_MATCH_INDICES
        nameMatches.push({ op, nameIndices, descriptionIndices })
        continue
      }
      const descriptionIndices = fuzzyMatchIndices(query, op.description)
      if (descriptionIndices) {
        descriptionOnlyMatches.push({ op, nameIndices: NO_MATCH_INDICES, descriptionIndices })
      }
    }
    return [...nameMatches, ...descriptionOnlyMatches]
  }, [query])

  return (
    <div className="opcode-reference">
      <div className="opcode-reference__search-row">
        <input
          type="text"
          className="opcode-reference__search"
          placeholder="Search opcodes…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="opcode-reference__count">
          {matched.length} / {OPCODE_REFERENCE.length}
        </span>
      </div>
      <div className="opcode-reference__scroll">
        <table className="opcode-reference__table">
          <tbody>
            {matched.map(({ op, nameIndices, descriptionIndices }) => (
              <tr key={op.name}>
                <td className="opcode-reference__name">
                  <Highlighted text={op.name} indices={nameIndices} />
                </td>
                <td className="opcode-reference__description">
                  <Highlighted text={op.description} indices={descriptionIndices} />
                </td>
              </tr>
            ))}
            {matched.length === 0 && (
              <tr>
                <td className="opcode-reference__empty" colSpan={2}>
                  no opcodes match &quot;{query}&quot;
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
