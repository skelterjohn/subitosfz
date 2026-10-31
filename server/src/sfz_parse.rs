// Parses an existing .sfz file and derives the note x articulation x
// velocity structure actually present in it, for populating the grid.
//
// The note axis is every MIDI key from the lowest lokey to the highest
// hikey used anywhere in the file (the instrument's full playable range),
// not just the keys with their own dedicated recording - a cell's lo/hi key
// span is reported so the UI can stretch it across every row it covers via
// pitch-shifting. Articulations and velocities are still only the distinct
// values actually present - those axes don't have a "range" concept.
//
// Scope: whitespace-tokenized opcode parsing with "greedy value" handling
// for unquoted multi-word values (e.g. sample paths with spaces), and
// proper global/master/group -> region opcode cascading. Does NOT handle
// #define/#include preprocessor directives.
//
// Cell take counts are "distinct sounds", not raw region counts: two
// regions sharing identical note/articulation/velocity AND identical
// round-robin/random-slot/trigger opcodes are the same recorded sound
// (e.g. a stereo pair split into separately panned L/R regions) and count
// once, not twice. Opcodes that don't gate *selection* - pan, volume, tune,
// envelope, the sample path itself - are irrelevant to this grouping.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::Serialize;

#[derive(Serialize, Clone, Copy)]
pub struct VelocityRange {
    pub lovel: u8,
    pub hivel: u8,
}

#[derive(Serialize, Clone)]
pub struct ArticulationInfo {
    pub id: String,
    pub label: String,
}

#[derive(Serialize)]
pub struct CellInfo {
    pub note: u8,
    pub articulation: String,
    #[serde(rename = "takeCount")]
    pub take_count: usize,
    #[serde(rename = "loKey")]
    pub lo_key: u8,
    #[serde(rename = "hiKey")]
    pub hi_key: u8,
    #[serde(rename = "loVel")]
    pub lo_vel: u8,
    #[serde(rename = "hiVel")]
    pub hi_vel: u8,
    // One representative sample for playback - the first take encountered,
    // not an exhaustive list. Fine for "click a cell to hear roughly what's
    // there"; real per-take playback is its own future UI.
    #[serde(rename = "samplePath")]
    pub sample_path: String,
}

#[derive(Serialize)]
pub struct ParsedSfz {
    pub notes: Vec<u8>,
    pub articulations: Vec<ArticulationInfo>,
    pub velocities: Vec<VelocityRange>,
    pub cells: Vec<CellInfo>,
}

#[derive(Clone, Copy, PartialEq)]
enum HeaderKind {
    None,
    Global,
    Master,
    Group,
    Region,
    Other,
}

type OpcodeMap = BTreeMap<String, String>;

// A token either starts a new "identifier=value" opcode, or (if it doesn't
// look like one) continues the previous token's value with a space - this
// is what lets unquoted values with spaces (e.g. sample paths) survive
// plain whitespace splitting.
fn tokenize_opcodes(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = match line.find("//") {
            Some(idx) => &line[..idx],
            None => line,
        };
        for word in line.split_whitespace() {
            if is_new_token_start(word) {
                tokens.push(word.to_string());
            } else if let Some(last) = tokens.last_mut() {
                last.push(' ');
                last.push_str(word);
            }
        }
    }
    tokens
}

fn is_new_token_start(word: &str) -> bool {
    if word.starts_with('<') {
        return true;
    }
    match word.find('=') {
        Some(eq) if eq > 0 => word[..eq]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_'),
        _ => false,
    }
}

fn flush_region(
    region: &mut Option<OpcodeMap>,
    global: &OpcodeMap,
    master: &OpcodeMap,
    group: &OpcodeMap,
    out: &mut Vec<OpcodeMap>,
) {
    if let Some(r) = region.take() {
        let mut merged = global.clone();
        merged.extend(master.clone());
        merged.extend(group.clone());
        merged.extend(r);
        out.push(merged);
    }
}

// The opcodes (beyond note/articulation/velocity) that determine whether
// two regions are selection-distinct "different sounds" rather than just
// different playback facets (pan, etc.) of the same recorded sound.
type SoundIdentity = (Option<String>, Option<String>, Option<String>, Option<String>);

fn sound_identity(region: &OpcodeMap) -> SoundIdentity {
    (
        region.get("seq_position").cloned(),
        region.get("lorand").cloned(),
        region.get("hirand").cloned(),
        region.get("trigger").cloned(),
    )
}

// The anchor note for a region: the pitch it was actually recorded at,
// used to group round-robin/stereo-split regions into one cell.
fn region_note(region: &OpcodeMap) -> Option<u8> {
    if let Some(v) = region.get("pitch_keycenter").or_else(|| region.get("key")) {
        if let Ok(n) = v.parse::<u8>() {
            return Some(n);
        }
    }
    let (lo, hi) = region_key_range(region)?;
    Some(((lo as u16 + hi as u16) / 2) as u8)
}

// The full key range a region actually triggers on - what the UI stretches
// a cell across, as opposed to region_note's single anchor point.
fn region_key_range(region: &OpcodeMap) -> Option<(u8, u8)> {
    let lokey = region.get("lokey").and_then(|v| v.parse::<u16>().ok());
    let hikey = region.get("hikey").and_then(|v| v.parse::<u16>().ok());
    match (lokey, hikey) {
        (Some(lo), Some(hi)) => Some((lo.min(127) as u8, hi.min(127) as u8)),
        (Some(lo), None) => Some((lo as u8, lo as u8)),
        (None, Some(hi)) => Some((hi as u8, hi as u8)),
        (None, None) => region
            .get("key")
            .or_else(|| region.get("pitch_keycenter"))
            .and_then(|v| v.parse::<u8>().ok())
            .map(|k| (k, k)),
    }
}

pub fn parse(path: &Path) -> Result<ParsedSfz, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("failed to read file: {e}"))?;
    let tokens = tokenize_opcodes(&text);

    let mut global = OpcodeMap::new();
    let mut master = OpcodeMap::new();
    let mut group = OpcodeMap::new();
    let mut region: Option<OpcodeMap> = None;
    let mut header = HeaderKind::None;

    let mut raw_regions: Vec<OpcodeMap> = Vec::new();

    for token in &tokens {
        if token.starts_with('<') {
            flush_region(&mut region, &global, &master, &group, &mut raw_regions);

            header = match token.as_str() {
                "<global>" => HeaderKind::Global,
                "<master>" => {
                    master.clear();
                    group.clear();
                    HeaderKind::Master
                }
                "<group>" => {
                    group.clear();
                    HeaderKind::Group
                }
                "<region>" => {
                    region = Some(OpcodeMap::new());
                    HeaderKind::Region
                }
                _ => HeaderKind::Other,
            };
            continue;
        }

        let Some(eq) = token.find('=') else { continue };
        let key = token[..eq].to_string();
        let value = token[eq + 1..].to_string();

        match header {
            HeaderKind::Global => {
                global.insert(key, value);
            }
            HeaderKind::Master => {
                master.insert(key, value);
            }
            HeaderKind::Group => {
                group.insert(key, value);
            }
            HeaderKind::Region => {
                if let Some(r) = region.as_mut() {
                    r.insert(key, value);
                }
            }
            HeaderKind::None | HeaderKind::Other => {}
        }
    }
    flush_region(&mut region, &global, &master, &group, &mut raw_regions);

    if raw_regions.is_empty() {
        return Err("no regions found in file".to_string());
    }

    // First pass: the note axis is the full playable range (lowest lokey to
    // highest hikey across every region), and we collect the distinct
    // articulations/velocities, so velocity indices are stable before we
    // group cells.
    let mut lo_bound: Option<u8> = None;
    let mut hi_bound: Option<u8> = None;
    let mut articulations: Vec<ArticulationInfo> = Vec::new();
    let mut velocities: Vec<VelocityRange> = Vec::new();

    for region in &raw_regions {
        if let Some((lo, hi)) = region_key_range(region) {
            lo_bound = Some(lo_bound.map_or(lo, |b: u8| b.min(lo)));
            hi_bound = Some(hi_bound.map_or(hi, |b: u8| b.max(hi)));
        }

        let articulation_id = region
            .get("sw_last")
            .cloned()
            .unwrap_or_else(|| "normal".to_string());
        if !articulations.iter().any(|a| a.id == articulation_id) {
            let label = region
                .get("sw_label")
                .cloned()
                .unwrap_or_else(|| articulation_id.clone());
            articulations.push(ArticulationInfo {
                id: articulation_id,
                label,
            });
        }

        let lovel = region.get("lovel").and_then(|v| v.parse::<u8>().ok()).unwrap_or(0);
        let hivel = region.get("hivel").and_then(|v| v.parse::<u8>().ok()).unwrap_or(127);
        if !velocities.iter().any(|v| v.lovel == lovel && v.hivel == hivel) {
            velocities.push(VelocityRange { lovel, hivel });
        }
    }

    let notes: Vec<u8> = match (lo_bound, hi_bound) {
        (Some(lo), Some(hi)) => (lo..=hi).collect(),
        _ => Vec::new(),
    };
    velocities.sort_by_key(|v| v.lovel);
    // Numeric keyswitch ids sort first in note order; "normal" (unparseable)
    // sorts last via None, which is still a sensible single-articulation
    // default position.
    articulations.sort_by_key(|a| a.id.parse::<u16>().ok());

    // Second pass: group regions per (note, articulation, lovel, hivel) cell
    // by distinct sound identity. The take count is the number of distinct
    // sounds, not raw region count - see module docs. lovel/hivel are part
    // of the grouping key itself (unlike loKey/hiKey, which aren't - a
    // region's own key range can vary slightly within a group, so that's
    // tracked separately as a min/max union instead).
    type CellKey = (u8, String, u8, u8);
    let mut cell_sounds: BTreeMap<CellKey, BTreeSet<SoundIdentity>> = BTreeMap::new();
    let mut cell_key_ranges: BTreeMap<CellKey, (u8, u8)> = BTreeMap::new();
    let mut cell_samples: BTreeMap<CellKey, String> = BTreeMap::new();
    for region in &raw_regions {
        let Some(note) = region_note(region) else { continue };
        let articulation_id = region
            .get("sw_last")
            .cloned()
            .unwrap_or_else(|| "normal".to_string());
        let lovel = region.get("lovel").and_then(|v| v.parse::<u8>().ok()).unwrap_or(0);
        let hivel = region.get("hivel").and_then(|v| v.parse::<u8>().ok()).unwrap_or(127);
        let key: CellKey = (note, articulation_id, lovel, hivel);

        cell_sounds
            .entry(key.clone())
            .or_default()
            .insert(sound_identity(region));

        if let Some((lo, hi)) = region_key_range(region) {
            cell_key_ranges
                .entry(key.clone())
                .and_modify(|(existing_lo, existing_hi)| {
                    *existing_lo = (*existing_lo).min(lo);
                    *existing_hi = (*existing_hi).max(hi);
                })
                .or_insert((lo, hi));
        }

        if let Some(sample) = region.get("sample") {
            cell_samples.entry(key).or_insert_with(|| sample.clone());
        }
    }

    let cells = cell_sounds
        .into_iter()
        .map(|((note, articulation, lovel, hivel), sounds)| {
            let (lo_key, hi_key) = cell_key_ranges
                .get(&(note, articulation.clone(), lovel, hivel))
                .copied()
                .unwrap_or((note, note));
            let sample_path = cell_samples
                .get(&(note, articulation.clone(), lovel, hivel))
                .cloned()
                .unwrap_or_default();
            CellInfo {
                note,
                articulation,
                take_count: sounds.len(),
                lo_key,
                hi_key,
                lo_vel: lovel,
                hi_vel: hivel,
                sample_path,
            }
        })
        .collect();

    Ok(ParsedSfz {
        notes,
        articulations,
        velocities,
        cells,
    })
}
