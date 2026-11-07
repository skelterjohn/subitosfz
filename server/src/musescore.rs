// "Apply to MuseScore" - points one or more tracks in an existing
// MuseScore 4 (.mscz) file at a chosen .sfz via its native sfizz VST3
// plugin, with no manual Mixer step required.
//
// A .mscz is a zip. MuseScore 4 keeps per-track sound routing in a plain
// audiosettings.json member (not in the .mscx notation XML) - that file's
// presence is also this module's test for "is this actually a MuseScore 4
// file" (MuseScore 3 and earlier have no such member). A track pointed at
// sfizz carries its state as a base64 VST3 "componentState" blob, which
// turned out not to be opaque: it's an 8-byte header, a 4-byte
// little-endian length, a null-terminated UTF-8 sfz path, then a fixed
// tail of default plugin parameters - see SFIZZ_COMPONENT_STATE_TAIL below.
// That model was confirmed empirically (decode a human-created blob,
// resynthesize one with a different path/length, reload in MuseScore) both
// on a track that already had sfizz assigned and on tracks that never had
// (going straight from a soundfont to sfizz with no prior manual step).
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Serialize)]
pub struct MuseScoreTrack {
    #[serde(rename = "partId")]
    pub part_id: String,
    #[serde(rename = "instrumentId")]
    pub instrument_id: Option<String>,
    pub label: String,
    #[serde(rename = "currentSound")]
    pub current_sound: String,
}

#[derive(Serialize)]
pub struct ArticulationMark {
    // "notehead" | "symbol" | "text" - distinguishes where the mark was
    // found (a notehead group, an <Articulation> symbol, or staff/playing
    // technique text), since all three can produce overlapping-looking
    // labels (e.g. a literal "pizzicato" symbol vs. the text "pizz.").
    pub kind: String,
    pub id: String,
    pub label: String,
    pub count: usize,
}

#[derive(Serialize)]
pub struct MuseScoreInfo {
    #[serde(rename = "formatVersion")]
    pub format_version: String,
    pub tracks: Vec<MuseScoreTrack>,
    pub articulations: Vec<ArticulationMark>,
}

#[derive(Serialize)]
pub struct ApplyResult {
    #[serde(rename = "tracksApplied")]
    pub tracks_applied: usize,
    #[serde(rename = "backupPath")]
    pub backup_path: String,
}

fn read_zip_entries(path: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let file = fs::File::open(path).map_err(|e| format!("failed to open file: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("failed to read musescore file: {e}"))?;

    let mut entries = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("failed to read archive entry: {e}"))?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("failed to read {name}: {e}"))?;
        entries.push((name, buf));
    }
    Ok(entries)
}

fn write_zip_entries(path: &Path, entries: &[(String, Vec<u8>)]) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| format!("failed to write file: {e}"))?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for (name, data) in entries {
        writer
            .start_file(name, options)
            .map_err(|e| format!("failed to write entry {name}: {e}"))?;
        writer
            .write_all(data)
            .map_err(|e| format!("failed to write entry {name}: {e}"))?;
    }
    writer
        .finish()
        .map_err(|e| format!("failed to finalize archive: {e}"))?;
    Ok(())
}

// First text child of an element - e.g. for <longName>Guitar 3</longName>,
// the longName node's own .text() is None (that's only set on text nodes
// themselves); this walks one level down to find it instead.
fn element_text<'a>(node: roxmltree::Node<'a, 'a>) -> Option<&'a str> {
    node.children().find_map(|c| c.text())
}

// Best-effort Part-id -> human label map (e.g. "1" -> "Classical Guitar"),
// read from the .mscx notation XML purely for display in the track picker.
// Returns an empty map on any parse failure rather than erroring the whole
// inspect() call - the sound-routing info from audiosettings.json is what
// actually matters; a missing label just falls back to the instrumentId.
fn part_labels(mscx_text: &str) -> HashMap<String, String> {
    let mut labels = HashMap::new();
    let Ok(doc) = roxmltree::Document::parse(mscx_text) else {
        return labels;
    };

    for part in doc.descendants().filter(|n| n.has_tag_name("Part")) {
        let Some(id) = part.attribute("id") else { continue };

        let long_name = part
            .descendants()
            .find(|n| n.has_tag_name("longName"))
            .and_then(element_text)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let track_name = part
            .descendants()
            .find(|n| n.has_tag_name("trackName"))
            .and_then(element_text)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if let Some(label) = long_name.or(track_name) {
            labels.insert(id.to_string(), label.to_string());
        }
    }

    labels
}

// "articStaccatoBelow" -> "Staccato". Above/Below/Left/Right are purely
// placement (which side of the staff the glyph is drawn on), not a
// different sound, so they're stripped first and merged into one mark;
// the "artic" prefix is just MuseScore's internal naming convention.
fn normalize_articulation_subtype(subtype: &str) -> String {
    let mut s = subtype;
    for suffix in ["Above", "Below", "Left", "Right", "Turned"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped;
        }
    }
    if let Some(stripped) = s.strip_prefix("artic") {
        s = stripped;
    }
    s.to_string()
}

// "UpBow" -> "up bow" - simple camelCase-to-words for a readable label.
fn camel_to_words(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() && i != 0 {
            out.push(' ');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

// Every distinct mark found in the piece that could plausibly be a
// playing-technique switch: notehead groups other than the default
// ("normal"), <Articulation> symbols (staccato, accent, up-bow, ...), and
// free text found on either a dedicated Playing Technique annotation or a
// plain staff text (MuseScore doesn't always use the dedicated element -
// this project's own test scores use plain StaffText for "pizz."-style
// markings too, and there's no reliable way to tell a real technique
// marking apart from an unrelated rehearsal note like "so much" by tag
// alone - every text mark is surfaced and left for the user to curate via
// the mapping UI, same as the original "let the user map texts, leaving
// many blank" plan).
fn find_articulations(mscx_text: &str) -> Vec<ArticulationMark> {
    let mut counts: HashMap<(&'static str, String), usize> = HashMap::new();
    let Ok(doc) = roxmltree::Document::parse(mscx_text) else {
        return Vec::new();
    };

    for note in doc.descendants().filter(|n| n.has_tag_name("Note")) {
        // Most notes have no <head> element at all - its absence means
        // "normal", the same as if it were written explicitly. Counting
        // that case too (rather than skipping it) lets the user map
        // "normal" to a target articulation as a deliberate assertion -
        // e.g. "every plain notehead should use this switch" - rather than
        // only ever being able to leave it unmapped.
        let head = note
            .children()
            .find(|n| n.has_tag_name("head"))
            .and_then(element_text)
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .unwrap_or("normal");
        *counts.entry(("notehead", head.to_string())).or_insert(0) += 1;
    }

    for articulation in doc.descendants().filter(|n| n.has_tag_name("Articulation")) {
        let subtype = articulation
            .children()
            .find(|n| n.has_tag_name("subtype"))
            .and_then(element_text)
            .map(str::trim);
        if let Some(subtype) = subtype.filter(|s| !s.is_empty()) {
            let label = camel_to_words(&normalize_articulation_subtype(subtype));
            if !label.is_empty() {
                *counts.entry(("symbol", label)).or_insert(0) += 1;
            }
        }
    }

    for annotation in doc
        .descendants()
        .filter(|n| n.has_tag_name("StaffText") || n.has_tag_name("PlayTechAnnotation"))
    {
        let text = annotation
            .children()
            .find(|n| n.has_tag_name("text"))
            .and_then(element_text)
            .map(str::trim);
        if let Some(text) = text.filter(|t| !t.is_empty()) {
            *counts.entry(("text", text.to_string())).or_insert(0) += 1;
        }
    }

    let mut out: Vec<ArticulationMark> = counts
        .into_iter()
        .map(|((kind, label), count)| ArticulationMark {
            kind: kind.to_string(),
            id: label.clone(),
            label,
            count,
        })
        .collect();
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.label.cmp(&b.label)));
    out
}

// Everything that makes this "is it actually a MuseScore 4 file" - its
// absence is also this module's required-version check, since
// audiosettings.json is a MuseScore 4 addition (MuseScore 3 keeps sound
// routing in the .mscx's <Channel> elements and a separate, score-external
// Synthesizer panel instead).
fn find_audiosettings(entries: &[(String, Vec<u8>)]) -> Result<usize, String> {
    entries
        .iter()
        .position(|(name, _)| name == "audiosettings.json")
        .ok_or_else(|| {
            "this file has no audiosettings.json - Subito requires MuseScore 4 (this looks like an older MuseScore file)".to_string()
        })
}

pub fn inspect(path: &Path) -> Result<MuseScoreInfo, String> {
    let entries = read_zip_entries(path)?;
    let settings_index = find_audiosettings(&entries)?;

    let mscx_text = entries
        .iter()
        .find(|(name, _)| name.ends_with(".mscx"))
        .map(|(_, data)| String::from_utf8_lossy(data).into_owned())
        .ok_or_else(|| "no .mscx found inside this file".to_string())?;

    let format_version = roxmltree::Document::parse(&mscx_text)
        .ok()
        .and_then(|doc| doc.root_element().attribute("version").map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let labels = part_labels(&mscx_text);
    let articulations = find_articulations(&mscx_text);

    let settings: Value = serde_json::from_slice(&entries[settings_index].1)
        .map_err(|e| format!("failed to parse audiosettings.json: {e}"))?;
    let tracks = settings
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or_else(|| "audiosettings.json has no tracks array".to_string())?;

    let out = tracks
        .iter()
        .map(|t| {
            let part_id = t
                .get("partId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let instrument_id = t
                .get("instrumentId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let current_sound = t
                .get("in")
                .and_then(|v| v.get("resourceMeta"))
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let label = labels
                .get(&part_id)
                .cloned()
                .or_else(|| instrument_id.clone())
                .unwrap_or_else(|| format!("Part {part_id}"));
            MuseScoreTrack {
                part_id,
                instrument_id,
                label,
                current_sound,
            }
        })
        .collect();

    Ok(MuseScoreInfo {
        format_version,
        tracks: out,
        articulations,
    })
}

// The fixed bytes following the length-prefixed sfz path in a sfizz VST3
// componentState blob - reverse-engineered from a known-good example (a
// human manually assigned sfizz and loaded an .sfz once via MuseScore's
// Mixer, then saved). Everything here turned out to be default plugin
// parameters independent of which file is loaded: resynthesizing a blob
// with a different path (and different length) while keeping this tail
// unchanged was confirmed to load correctly in sfizz, including on tracks
// that had never been manually assigned to sfizz before. If a future
// sfizz version changes its default state layout, this would need
// re-deriving the same way: assign it once by hand, decode the new blob.
const SFIZZ_COMPONENT_STATE_TAIL: [u8; 77] = [
    0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00,
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x00, 0x00, 0x00, 0xdc, 0x43, 0x00,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x03, 0x00, 0x00, 0x00, 0x07,
    0x00, 0x26, 0x93, 0x49, 0x3f, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x3f, 0x0b, 0x00, 0x00, 0x00,
    0x80, 0x3f,
];

fn sfizz_component_state(sfz_path: &str) -> String {
    // Forward-slash, matching the convention seen in every observed blob
    // (and the rest of this codebase's own sample= paths - see sf2.rs).
    let normalized = sfz_path.replace('\\', "/");
    let mut path_bytes = normalized.into_bytes();
    path_bytes.push(0); // nul terminator, counted in the length prefix below

    let mut blob =
        Vec::with_capacity(8 + 4 + path_bytes.len() + SFIZZ_COMPONENT_STATE_TAIL.len());
    blob.extend_from_slice(&[0x05, 0, 0, 0, 0, 0, 0, 0]);
    blob.extend_from_slice(&(path_bytes.len() as u32).to_le_bytes());
    blob.extend_from_slice(&path_bytes);
    blob.extend_from_slice(&SFIZZ_COMPONENT_STATE_TAIL);

    STANDARD.encode(blob)
}

fn backup_path_for(musescore_path: &Path) -> PathBuf {
    let mut name = musescore_path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    name.push(".bak");
    musescore_path.with_file_name(name)
}

// Points every track in `part_ids` at `sfz_path` via sfizz, leaving every
// other field (aux sends, volume, mute/solo, the .mscx itself) untouched.
// Backs up the original file first (`<name>.mscz.bak`, overwritten on
// repeat use) since this writes raw zip/JSON rather than going through
// MuseScore's own save path.
pub fn apply(
    musescore_path: &Path,
    sfz_path: &str,
    part_ids: &[String],
) -> Result<ApplyResult, String> {
    if part_ids.is_empty() {
        return Err("no tracks selected".to_string());
    }
    if !Path::new(sfz_path).is_file() {
        return Err(format!("sfz file not found: {sfz_path}"));
    }

    let mut entries = read_zip_entries(musescore_path)?;
    let settings_index = find_audiosettings(&entries)?;

    let mut settings: Value = serde_json::from_slice(&entries[settings_index].1)
        .map_err(|e| format!("failed to parse audiosettings.json: {e}"))?;

    let sfizz_in = serde_json::json!({
        "resourceMeta": {
            "attributes": {
                "categories": "Instrument|Synth",
                "playbackSetupData": "last.last.last"
            },
            "hasNativeEditorSupport": true,
            "id": "sfizz",
            "type": "vst_plugin",
            "vendor": "SFZTools"
        },
        "unitConfiguration": {
            "componentState": sfizz_component_state(sfz_path)
        }
    });

    let tracks = settings
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "audiosettings.json has no tracks array".to_string())?;

    let mut applied = 0usize;
    for track in tracks.iter_mut() {
        let part_id = track
            .get("partId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !part_ids.iter().any(|p| p == &part_id) {
            continue;
        }
        if let Some(obj) = track.as_object_mut() {
            obj.insert("in".to_string(), sfizz_in.clone());
        }
        applied += 1;
    }

    if applied == 0 {
        return Err("none of the selected part IDs were found in this file".to_string());
    }

    entries[settings_index].1 = serde_json::to_vec_pretty(&settings)
        .map_err(|e| format!("failed to serialize audiosettings.json: {e}"))?;

    let backup_path = backup_path_for(musescore_path);
    fs::copy(musescore_path, &backup_path).map_err(|e| format!("failed to create backup: {e}"))?;

    write_zip_entries(musescore_path, &entries)?;

    Ok(ApplyResult {
        tracks_applied: applied,
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}
