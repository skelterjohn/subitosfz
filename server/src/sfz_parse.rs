// Parses an existing .sfz file and derives the note x articulation x
// velocity structure actually present in it, for populating the grid.
// Only what's actually in the file shows up - no padding out to a full
// chromatic range or a default articulation/velocity set.
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
    #[serde(rename = "velocityIndex")]
    pub velocity_index: usize,
    #[serde(rename = "takeCount")]
    pub take_count: usize,
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

fn region_note(region: &OpcodeMap) -> Option<u8> {
    if let Some(v) = region.get("pitch_keycenter").or_else(|| region.get("key")) {
        if let Ok(n) = v.parse::<u8>() {
            return Some(n);
        }
    }
    let lokey = region.get("lokey").and_then(|v| v.parse::<u16>().ok());
    let hikey = region.get("hikey").and_then(|v| v.parse::<u16>().ok());
    match (lokey, hikey) {
        (Some(lo), Some(hi)) => Some(((lo + hi) / 2) as u8),
        (Some(lo), None) => Some(lo as u8),
        (None, Some(hi)) => Some(hi as u8),
        (None, None) => None,
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

    // First pass: collect the distinct notes/articulations/velocities that
    // actually appear, so velocity indices are stable before we count cells.
    let mut notes: Vec<u8> = Vec::new();
    let mut articulations: Vec<ArticulationInfo> = Vec::new();
    let mut velocities: Vec<VelocityRange> = Vec::new();

    for region in &raw_regions {
        if let Some(note) = region_note(region) {
            if !notes.contains(&note) {
                notes.push(note);
            }
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

    notes.sort_unstable();
    velocities.sort_by_key(|v| v.lovel);
    // Numeric keyswitch ids sort first in note order; "normal" (unparseable)
    // sorts last via None, which is still a sensible single-articulation
    // default position.
    articulations.sort_by_key(|a| a.id.parse::<u16>().ok());

    // Second pass: group regions per (note, articulation, velocity) cell by
    // distinct sound identity, now that velocity indices are stable. The
    // take count is the number of distinct sounds, not raw region count -
    // see module docs.
    let mut cell_sounds: BTreeMap<(u8, String, usize), BTreeSet<SoundIdentity>> = BTreeMap::new();
    for region in &raw_regions {
        let Some(note) = region_note(region) else { continue };
        let articulation_id = region
            .get("sw_last")
            .cloned()
            .unwrap_or_else(|| "normal".to_string());
        let lovel = region.get("lovel").and_then(|v| v.parse::<u8>().ok()).unwrap_or(0);
        let hivel = region.get("hivel").and_then(|v| v.parse::<u8>().ok()).unwrap_or(127);
        let velocity_index = velocities
            .iter()
            .position(|v| v.lovel == lovel && v.hivel == hivel)
            .unwrap();

        cell_sounds
            .entry((note, articulation_id, velocity_index))
            .or_default()
            .insert(sound_identity(region));
    }

    let cells = cell_sounds
        .into_iter()
        .map(|((note, articulation, velocity_index), sounds)| CellInfo {
            note,
            articulation,
            velocity_index,
            take_count: sounds.len(),
        })
        .collect();

    Ok(ParsedSfz {
        notes,
        articulations,
        velocities,
        cells,
    })
}
