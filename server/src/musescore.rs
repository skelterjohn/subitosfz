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
use std::collections::{HashMap, HashSet};
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
    #[serde(rename = "keyswitchSfzPath")]
    pub keyswitch_sfz_path: String,
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

// --- Keyswitch injection ---
//
// Turns a user's articulation mapping into real hidden notes in the
// score. Two different attachment rules, deliberately: a notehead or
// <Articulation> symbol mark applies ONLY to the exact chord it's on
// (real notation convention - a staccato dot is per-note), while a
// StaffText/PlayTechAnnotation mark is positional (not nested in a
// chord - see find_articulations' own doc comment) and, once seen,
// persists as the "current mode" for every later chord in that voice
// until a later text mark changes it (a real "pizz."..."arco" marking
// is a mode switch, not a single-note annotation). A switch note is
// injected on EVERY chord (not just at transitions) since sfizz's switch
// state otherwise persists indefinitely until the next one - "only
// inject on change" would be a later efficiency nicety, not attempted
// here. v1 limitation: only Staff ids matching a selected partId are
// walked (single-staff-per-part assumed - a piano's second staff, or a
// guitar's linked TAB staff, aren't handled), and only each Measure's
// FIRST <voice> child (voices 2-4 ignored).
const NONE_SENTINEL: &str = "__none__";

// None = "no mapping for this mark, fall through to whatever's next in
// the resolution order" - deliberately distinct from Some(NONE_SENTINEL)
// ("explicitly silence this mark") and from an unmapped mark being
// treated as a reset (see the StaffText handling below, where this
// matters: an unmapped text annotation - e.g. a decorative rehearsal
// label like "theme" that happens to use the same tag as a real
// technique marking - must NOT cancel whatever real technique mode is
// already in effect).
fn resolve_mark(mapping: &HashMap<String, String>, key: &str) -> Option<String> {
    match mapping.get(key).map(String::as_str) {
        Some("") | None => None,
        Some(v) => Some(v.to_string()),
    }
}

// Marks directly attached to this chord's own content - articulation
// symbols checked first (a more deliberate marking than a notehead
// convention), then noteheads (absent <head> defaults to "normal", same
// as find_articulations' own scan).
fn chord_direct_mark(chord: roxmltree::Node, mapping: &HashMap<String, String>) -> Option<String> {
    for art in chord.children().filter(|n| n.has_tag_name("Articulation")) {
        let subtype = art
            .children()
            .find(|n| n.has_tag_name("subtype"))
            .and_then(element_text)
            .map(str::trim);
        if let Some(subtype) = subtype.filter(|s| !s.is_empty()) {
            let label = camel_to_words(&normalize_articulation_subtype(subtype));
            if let Some(resolved) = resolve_mark(mapping, &format!("symbol:{label}")) {
                return Some(resolved);
            }
        }
    }
    for note in chord.children().filter(|n| n.has_tag_name("Note")) {
        let head = note
            .children()
            .find(|n| n.has_tag_name("head"))
            .and_then(element_text)
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .unwrap_or("normal");
        if let Some(resolved) = resolve_mark(mapping, &format!("notehead:{head}")) {
            return Some(resolved);
        }
    }
    None
}

// Standard MuseScore tonal-pitch-class value per chroma (C=0..B=11) -
// confirmed against a real file (pitch 59 / B -> tpc 19, index 11 here).
// Only used for hidden keyswitch notes, so any valid spelling is fine.
const TPC_BY_CHROMA: [i8; 12] = [14, 21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19];

// A fixed, recognizable prefix on every injected note's synthetic eid -
// the "signature" that lets a later apply find and remove its own
// previous injections before adding fresh ones (see
// remove_previous_keyswitch_notes), rather than stacking duplicates on
// every repeat apply.
const KEYSWITCH_EID_PREFIX: &str = "subitosfz-ks-";

// Not a real MuseScore-format id (the exact generation algorithm is
// unknown) - just a syntactically plausible, guaranteed-unique-within-
// this-file opaque string in the same base64-ish-with-underscore shape
// observed in real files, just with the recognizable prefix above.
// Counter-seeded rather than truly random so it needs no new dependency -
// adding `rand` would reintroduce the same getrandom/dlltool build issue
// already hit and avoided for `zip`.
fn random_eid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = COUNTER.fetch_add(1, Ordering::Relaxed) ^ nanos ^ 0x9E3779B97F4A7C15;

    let mut segment = |len: usize| -> String {
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                ALPHABET[(x as usize) % ALPHABET.len()] as char
            })
            .collect()
    };
    format!("{KEYSWITCH_EID_PREFIX}{}_{}", segment(11), segment(11))
}

// Deletes every Part+Staff pair left over from a previous apply
// (identified by the KEYSWITCH_EID_PREFIX signature on the Part's own
// Instrument id), so repeat applies replace the hidden keyswitch staff
// rather than accumulating a new one on every apply. Global, not scoped
// to the currently-selected parts - a previous apply to a different part
// selection shouldn't leave orphaned staves behind either.
// Deliberately NOT extended to <play>0</play> mute flags (added for
// NONE_SENTINEL-mapped marks): a bare flag on an existing real note has
// no equivalent signature to distinguish "Subito added this" from a mute
// the user set themselves by hand, so auto-removing it risks undoing the
// user's own work - documented gap, not attempted here.
// Returns the removed Parts' own ids too - next_part_id/next_staff_id/
// next_midi_channel below need to exclude them from their "max so far"
// scan, or every re-apply permanently skips the ids/channels this just
// freed (confirmed by hand: ids 4-6 removed, next apply allocates 7-9
// instead of reusing 4-6, and the gap only widens on each further
// re-apply) - doc is still the pre-edit parse tree, so the stale Parts
// are still right there to be counted unless explicitly excluded.
fn remove_previous_keyswitch_staves(
    doc: &roxmltree::Document,
    edits: &mut Vec<(std::ops::Range<usize>, String)>
) -> HashSet<String> {
    let mut stale_part_ids = HashSet::new();
    for part in doc.descendants().filter(|n| n.has_tag_name("Part")) {
        let is_ours = part
            .descendants()
            .find(|n| n.has_tag_name("Instrument"))
            .and_then(|i| i.attribute("id"))
            .is_some_and(|id| id.starts_with(KEYSWITCH_EID_PREFIX));
        if !is_ours {
            continue;
        }
        edits.push((part.range(), String::new()));
        if let Some(part_id) = part.attribute("id") {
            stale_part_ids.insert(part_id.to_string());
            if let Some(staff) = doc
                .descendants()
                .find(|n| n.has_tag_name("Staff") && n.attribute("id") == Some(part_id))
            {
                edits.push((staff.range(), String::new()));
            }
        }
    }
    stale_part_ids
}

// Max value of an attribute across every element with the given tag,
// ignoring values equal to one of exclude_ids - used so a stale Part/
// Staff id about to be deleted this same apply doesn't push the next
// allocated id past it.
fn max_attr_value_excluding(doc: &roxmltree::Document, tag: &str, attr: &str, exclude_ids: &HashSet<String>) -> u32 {
    doc.descendants()
        .filter(|n| n.has_tag_name(tag))
        .filter_map(|n| n.attribute(attr))
        .filter(|v| !exclude_ids.contains(*v))
        .filter_map(|v| v.parse::<u32>().ok())
        .max()
        .unwrap_or(0)
}

// Same idea as max_attr_value_excluding, but for <midiChannel> - which
// has no id of its own, so exclusion is by whether its nearest ancestor
// <Part>'s id is stale.
fn max_midi_channel_excluding(doc: &roxmltree::Document, exclude_part_ids: &HashSet<String>) -> u32 {
    doc.descendants()
        .filter(|n| n.has_tag_name("midiChannel"))
        .filter(|n| {
            n.ancestors()
                .find(|a| a.has_tag_name("Part"))
                .and_then(|p| p.attribute("id"))
                .map(|id| !exclude_part_ids.contains(id))
                .unwrap_or(true)
        })
        .filter_map(element_text)
        .filter_map(|t| t.trim().parse::<u32>().ok())
        .max()
        .unwrap_or(0)
}

// A Chord or Rest's own duration-defining children (durationType and
// dots, if present), copied verbatim as raw text - the minimum needed to
// replicate a measure's timing on the mirrored keyswitch staff, with no
// parsing/reformatting risk. Tuplets aren't specially handled - an
// accepted v1 limitation (not exercised by any score tested so far).
// Swaps in a fresh eid for a verbatim-copied element's own <eid>...</eid>,
// since copying TimeSig/KeySig/Dynamic XML as-is onto the hidden staff
// would otherwise duplicate the eid already present on the real staff's
// copy of the same element - confirmed to crash MuseScore on load (eid
// is a global uniqueness key, not scoped per-staff).
fn with_fresh_eid(xml: &str) -> String {
    if let Some(start) = xml.find("<eid>") {
        let after_tag = start + "<eid>".len();
        if let Some(end_rel) = xml[after_tag..].find("</eid>") {
            let end = after_tag + end_rel;
            let mut out = String::with_capacity(xml.len());
            out.push_str(&xml[..after_tag]);
            out.push_str(&random_eid());
            out.push_str(&xml[end..]);
            return out;
        }
    }
    xml.to_string()
}

fn duration_xml(node: roxmltree::Node, source: &str) -> String {
    let mut out = String::new();
    if let Some(dt) = node.children().find(|n| n.has_tag_name("durationType")) {
        out.push_str(&source[dt.range()]);
    }
    if let Some(dots) = node.children().find(|n| n.has_tag_name("dots")) {
        out.push_str(&source[dots.range()]);
    }
    out
}

// The grace-note type marker on a Chord, if it's itself a grace note -
// a self-closing tag like <grace32/> (or <appoggiatura/>/<acciaccatura/>,
// MuseScore's other grace-note spellings), always a sibling of
// durationType/Note rather than nested in either. This is what tells
// MuseScore the chord consumes no real measure duration regardless of
// its nominal durationType - dropping it when mirroring a chord that
// carries one is what corrupted the file (see the call site's comment).
fn grace_marker_xml<'a>(chord: roxmltree::Node, source: &'a str) -> Option<&'a str> {
    chord
        .children()
        .find(|n| {
            n.is_element()
                && (n.tag_name().name().starts_with("grace")
                    || n.tag_name().name() == "appoggiatura"
                    || n.tag_name().name() == "acciaccatura")
        })
        .map(|n| &source[n.range()])
}

// Fresh <Note> elements (new eid each, not the original's) carrying just
// pitch+tpc from a real Chord's own notes - used to copy the actual
// performance onto the hidden keyswitch staff alongside the switch note.
// A new eid rather than copying the source Note's own XML verbatim,
// since reusing an eid that already exists elsewhere in the file (on the
// real, visible note) risks a duplicate-id problem.
//
// Also carries over each note's own <Spanner type="Tie"> if present -
// without it, a tied note loses the tie on this hidden copy and gets a
// fresh attack at the second note instead of sustaining, so the mirrored
// performance audibly re-strikes notes the real one just holds (confirmed
// by ear). The mirrored staff has the identical rhythm as the real one,
// so the tie's own <next>/<prev> relative-offset fractions stay valid
// unchanged; only the <Tie> element's own eid (present on the starting
// half, absent on the continuation half - see with_fresh_eid) needs
// swapping for the same duplicate-eid reason as TimeSig/KeySig/Dynamic.
fn chord_notes_xml(chord: roxmltree::Node, mscx_text: &str) -> String {
    let mut out = String::new();
    for note in chord.children().filter(|n| n.has_tag_name("Note")) {
        let pitch = note
            .children()
            .find(|n| n.has_tag_name("pitch"))
            .and_then(element_text)
            .unwrap_or("60");
        let tpc = note
            .children()
            .find(|n| n.has_tag_name("tpc"))
            .and_then(element_text)
            .unwrap_or("14");
        let tie = note
            .children()
            .find(|n| n.has_tag_name("Spanner") && n.attribute("type") == Some("Tie"))
            .map(|n| with_fresh_eid(&mscx_text[n.range()]))
            .unwrap_or_default();
        out.push_str(&format!(
            "<Note><eid>{}</eid><pitch>{pitch}</pitch><tpc>{tpc}</tpc>{tie}</Note>",
            random_eid()
        ));
    }
    out
}

// Result of injecting keyswitches: the new .mscx text, plus (partId,
// Instrument id) for each newly-created hidden keyswitch staff - apply()
// needs both to give each one its own audiosettings.json track entry,
// keyed by the SAME Instrument id as the one actually written into the
// mscx (confirmed by hand to be the real lookup key MuseScore's Mixer
// uses to bind a sound to a track - not partId, which is present but
// apparently just carried-along metadata).
struct InjectResult {
    mscx_text: String,
    new_parts: Vec<(String, String)>,
}

// Builds one dedicated, hidden keyswitch staff per selected part, rather
// than injecting switch notes into the real notation staff. Three
// iterations of the latter (an extra Note in the host chord, a separate
// grace-note Chord, Chord-level <visible>) all left the *printed/exported*
// layout stretched vertically - confirmed each time against real PDF
// output, not just the edit view - because MuseScore's layout engine
// reserves vertical space from a note's real pitch regardless of any
// invisible flag at any level tried. The fix, confirmed by hand (add a
// plain second staff, put an extreme-pitch note on it, hide the STAFF
// itself via the Instruments panel visibility toggle, confirm clean in
// both edit view and printed PDF): hiding a whole staff is a different,
// apparently more fundamental mechanism than hiding an element within an
// existing one.
//
// A second problem surfaced once the hidden staff became its own
// separate Part: giving it the exact same sfizz plugin assignment as the
// real part doesn't make them share internal keyswitch state - confirmed
// by hand that it instead silences the real part's own audio entirely
// (two Parts = two independent plugin instances, and identical config
// across them breaks rather than shares). The fix: this hidden staff now
// carries the FULL performance, not just switch blips - a fresh copy of
// every real note (see chord_notes_xml), stacked together with the
// switch note in the same chord, same as the original same-staff design
// that was confirmed working by ear. The real/visible staff is left
// completely unmodified and muted at the Mixer level instead (see
// apply()) - the switch and the sound it affects now share one plugin
// instance again, just on a staff nobody sees rather than the real one.
fn inject_keyswitches(
    mscx_text: &str,
    part_ids: &[String],
    mark_mapping: &HashMap<String, String>,
    default_articulation: &str,
    articulation_notes: &HashMap<String, u8>,
) -> Result<InjectResult, String> {
    let doc = roxmltree::Document::parse(mscx_text).map_err(|e| format!("failed to parse mscx: {e}"))?;
    let default_resolved = (!default_articulation.is_empty()).then(|| default_articulation.to_string());

    // (byte range, replacement text), computed against the ORIGINAL text
    // and applied back-to-front - same discipline sfz_write.rs uses. A
    // pure insertion is a zero-width range (offset..offset).
    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    let mut new_parts: Vec<(String, String)> = Vec::new();

    let stale_part_ids = remove_previous_keyswitch_staves(&doc, &mut edits);

    let (switch_lo, switch_hi) = match (
        articulation_notes.values().copied().min(),
        articulation_notes.values().copied().max(),
    ) {
        (Some(lo), Some(hi)) => (lo, hi),
        _ => (0, 0), // no articulations at all - nothing to switch, loop below just does nothing
    };

    let mut next_part_id = max_attr_value_excluding(&doc, "Part", "id", &stale_part_ids) + 1;
    let mut next_staff_id = max_attr_value_excluding(&doc, "Staff", "id", &stale_part_ids) + 1;
    let mut next_midi_channel = max_midi_channel_excluding(&doc, &stale_part_ids) + 1;

    // Grouped at the end: every new Part/Staff is appended together after
    // the last existing one, not interleaved right after each
    // corresponding real target. Confirmed by direct A/B comparison on
    // clean files (no pre-existing cruft) that grouped-at-the-end lays
    // out correctly (real staves' order is left completely undisturbed,
    // the one thing already known to work) while interleaving does not
    // (tried twice, on two different clean files, same cross-wired
    // result both times) - an earlier read of a user report seemed to
    // argue FOR interleaving by a positional-index argument, but that
    // turned out to be a misanalysis; empirical A/B testing overrides it.
    let mut all_new_parts_xml = String::new();
    let mut all_new_staves_xml = String::new();

    for part in doc.descendants().filter(|n| n.has_tag_name("Part")) {
        let Some(part_id_str) = part.attribute("id") else { continue };
        if !part_ids.iter().any(|p| p == part_id_str) {
            continue;
        }
        let Some(real_staff) = doc
            .descendants()
            .find(|n| n.has_tag_name("Staff") && n.attribute("id") == Some(part_id_str))
        else {
            continue; // no notation content for this part - nothing to mirror
        };
        let Some(instrument) = part.descendants().find(|n| n.has_tag_name("Instrument")) else {
            continue;
        };
        if articulation_notes.is_empty() {
            continue;
        }

        let new_part_id = next_part_id;
        let new_staff_id = next_staff_id;
        let open_channel = next_midi_channel;
        let mute_channel = next_midi_channel + 1;
        next_part_id += 1;
        next_staff_id += 1;
        next_midi_channel += 2;

        // Suffixed with new_part_id below (not used bare) - all three real
        // guitars here share the SAME underlying instrument_id
        // ("guitar-nylon"), and giving every synthetic keyswitch
        // Instrument that identical id too (confirmed by hand: this was
        // the actual bug behind content appearing to cross-wire between
        // staves, independent of how Part/Staff document order was
        // arranged - MuseScore evidently treats Instrument id as more
        // than a label).
        let instrument_id = instrument.attribute("id").unwrap_or("instrument");
        let mscx_instrument_id = format!("{KEYSWITCH_EID_PREFIX}{instrument_id}-{new_part_id}");
        new_parts.push((new_part_id.to_string(), mscx_instrument_id.clone()));
        let long_name = instrument
            .children()
            .find(|n| n.has_tag_name("longName"))
            .and_then(element_text)
            .unwrap_or("")
            .trim();
        let track_name = instrument
            .children()
            .find(|n| n.has_tag_name("trackName"))
            .and_then(element_text)
            .unwrap_or("")
            .trim();
        let instrument_id_value = instrument
            .children()
            .find(|n| n.has_tag_name("instrumentId"))
            .and_then(element_text)
            .unwrap_or("")
            .trim();
        let clef = instrument
            .children()
            .find(|n| n.has_tag_name("clef"))
            .and_then(element_text)
            .unwrap_or("G")
            .trim();
        let default_clef = part
            .descendants()
            .find(|n| n.has_tag_name("defaultClef"))
            .and_then(element_text)
            .unwrap_or("G")
            .trim();
        // Copied verbatim if present - harmless on a pitched (non-tab)
        // staff, same as it already is on the real staff's own
        // Instrument block.
        let string_data = instrument
            .children()
            .find(|n| n.has_tag_name("StringData"))
            .map(|n| &mscx_text[n.range()])
            .unwrap_or("");

        let new_part_xml = format!(
            "<Part id=\"{new_part_id}\">\
<Staff>\
<eid>{}</eid>\
<StaffType group=\"pitched\"><name>stdNormal</name><invisible>1</invisible></StaffType>\
<defaultClef>{default_clef}</defaultClef>\
<isStaffVisible>0</isStaffVisible>\
</Staff>\
<show>0</show>\
<trackName>{track_name}</trackName>\
<Instrument id=\"{mscx_instrument_id}\">\
<longName>{long_name} - subito keyswitches</longName>\
<shortName>{long_name} - subito keyswitches</shortName>\
<trackName>{track_name}</trackName>\
<minPitchP>{switch_lo}</minPitchP><maxPitchP>{switch_hi}</maxPitchP>\
<minPitchA>{switch_lo}</minPitchA><maxPitchA>{switch_hi}</maxPitchA>\
<instrumentId>{instrument_id_value}</instrumentId>\
<clef>{clef}</clef>\
{string_data}\
<Channel name=\"open\"><program value=\"0\"/><synti>Fluid</synti><midiPort>0</midiPort><midiChannel>{open_channel}</midiChannel></Channel>\
<Channel name=\"mute\"><program value=\"0\"/><synti>Fluid</synti><midiPort>0</midiPort><midiChannel>{mute_channel}</midiChannel></Channel>\
</Instrument>\
</Part>\n",
            random_eid()
        );
        all_new_parts_xml.push_str(&new_part_xml);

        // One pass over the real staff's rhythm, both collecting mute
        // edits for the real notes (NONE_SENTINEL case, unchanged from
        // before) and building the mirrored keyswitch staff's content in
        // lockstep, so every switch event lands at the same tick as the
        // chord it switches.
        let mut current_text_mode: Option<String> = None;
        let mut staff_body = String::new();

        for measure in real_staff.children().filter(|n| n.has_tag_name("Measure")) {
            staff_body.push_str("<Measure><voice>");
            if let Some(voice) = measure.children().find(|n| n.has_tag_name("voice")) {
                for child in voice.children().filter(|n| n.is_element()) {
                    // TimeSig/KeySig keep the hidden staff's own measure
                    // durations correct; Dynamic is copied too since this
                    // staff now carries the actual audible performance
                    // (not just switch blips) - MuseScore computes note
                    // velocity from the nearest preceding Dynamic itself,
                    // so copying the marking is enough, no manual
                    // velocity computation needed here. Hairpins/ties
                    // aren't specially handled - accepted v1 limitation,
                    // not attempted (gradual dynamics and sustained ties
                    // may not reproduce exactly on this hidden copy).
                    if child.has_tag_name("TimeSig") || child.has_tag_name("KeySig") || child.has_tag_name("Dynamic") {
                        staff_body.push_str(&with_fresh_eid(&mscx_text[child.range()]));
                        continue;
                    }
                    if child.has_tag_name("StaffText") || child.has_tag_name("PlayTechAnnotation") {
                        let text = child
                            .children()
                            .find(|n| n.has_tag_name("text"))
                            .and_then(element_text)
                            .map(str::trim);
                        if let Some(text) = text.filter(|t| !t.is_empty()) {
                            // Only overwrite the running mode on a mark
                            // that actually resolves to something - an
                            // unmapped text annotation (e.g. a decorative
                            // rehearsal label sharing the same tag) must
                            // not cancel a real technique mode already in
                            // effect.
                            if let Some(resolved) = resolve_mark(mark_mapping, &format!("text:{text}")) {
                                current_text_mode = Some(resolved);
                            }
                        }
                        continue;
                    }
                    if child.has_tag_name("Rest") {
                        staff_body.push_str(&format!(
                            "<Rest><eid>{}</eid>{}</Rest>",
                            random_eid(),
                            duration_xml(child, mscx_text)
                        ));
                        continue;
                    }
                    if !child.has_tag_name("Chord") {
                        continue; // Tempo, Spanner, Fingering, Articulation - irrelevant here
                    }

                    let resolved = chord_direct_mark(child, mark_mapping)
                        .or_else(|| current_text_mode.clone())
                        .or_else(|| default_resolved.clone())
                        .unwrap_or_else(|| "normal".to_string());
                    let duration = duration_xml(child, mscx_text);
                    // Whether the SOURCE chord is itself a grace note -
                    // confirmed the hard way that this isn't optional:
                    // mirroring a source grace note without its own marker
                    // (counting it as a real timed note instead) corrupted
                    // the file outright ("Incomplete measure... Found
                    // 41/32, Expected 5/4" - exactly the 1/32 excess of one
                    // unmarked 32nd grace note).
                    let grace_marker = grace_marker_xml(child, mscx_text);

                    if resolved == NONE_SENTINEL {
                        // The real staff is muted at the Mixer level (see
                        // apply()), so there's nothing to silence there
                        // anymore - this chord just contributes no sound
                        // at all on the hidden (audible) staff either. A
                        // silenced grace note gets nothing at all, not even
                        // a Rest - the original consumed no real measure
                        // time either, and a Rest standing in for it would.
                        if grace_marker.is_none() {
                            staff_body.push_str(&format!("<Rest><eid>{}</eid>{duration}</Rest>", random_eid()));
                        }
                        continue;
                    }

                    let Some(&note_number) = articulation_notes.get(&resolved) else {
                        return Err(format!("no reserved keyswitch note for articulation \"{resolved}\""));
                    };
                    let tpc = TPC_BY_CHROMA[(note_number % 12) as usize];
                    // A separate grace-note Chord for the switch trigger
                    // was tried and reverted: a grace note doesn't consume
                    // notated measure duration, but it DOES consume real
                    // playback time, and since the switch note itself is
                    // silent by design (see build_keyswitch_variant's
                    // region-range clamping), that stolen sliver of time
                    // played back as an audible gap before every single
                    // note (confirmed by ear - "a 32nd of rest before each
                    // note"). Back to one simultaneous Chord instead, with
                    // the switch Note placed first/lowest-pitched -
                    // build_keyswitch_variant now reserves the BOTTOM of
                    // the MIDI range rather than the top, on the theory
                    // that simultaneous notes dispatch in pitch-ascending
                    // order rather than document order (confirmed by ear
                    // that document order alone, with the switch note
                    // previously at the chord's highest pitch, consistently
                    // fired the switch after the note it was meant to
                    // affect).
                    staff_body.push_str(&format!(
                        "<Chord><eid>{}</eid>{duration}{}<Note><eid>{}</eid><pitch>{note_number}</pitch><tpc>{tpc}</tpc></Note>{}</Chord>",
                        random_eid(),
                        grace_marker.unwrap_or(""),
                        random_eid(),
                        chord_notes_xml(child, mscx_text)
                    ));
                }
            }
            staff_body.push_str("</voice></Measure>");
        }

        let new_staff_xml = format!("<Staff id=\"{new_staff_id}\">{staff_body}</Staff>\n");
        all_new_staves_xml.push_str(&new_staff_xml);
    }

    if !all_new_parts_xml.is_empty() {
        if let Some(last_part) = doc.descendants().filter(|n| n.has_tag_name("Part")).last() {
            let offset = last_part.range().end;
            edits.push((offset..offset, all_new_parts_xml));
        }
    }
    if !all_new_staves_xml.is_empty() {
        if let Some(last_staff) = doc
            .descendants()
            .filter(|n| n.has_tag_name("Staff") && n.attribute("id").is_some())
            .last()
        {
            let offset = last_staff.range().end;
            edits.push((offset..offset, all_new_staves_xml));
        }
    }

    // Descending by start, so each splice doesn't invalidate the offsets
    // of edits still waiting to be applied - same discipline sfz_write.rs
    // uses for its own multi-offset splices.
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));

    let mut new_text = mscx_text.to_string();
    for (range, replacement) in edits {
        new_text.replace_range(range, &replacement);
    }
    Ok(InjectResult { mscx_text: new_text, new_parts })
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

// Points every track in `part_ids` at a derived, keyswitch-enabled copy
// of `sfz_path` via sfizz (see build_keyswitch_variant - the user's real
// .sfz is never touched), injects hidden keyswitch notes into the
// selected tracks' own notation per `articulation_mapping`/
// `default_articulation_id`, and leaves every other field (aux sends,
// volume, mute/solo) untouched. Backs up the original file first
// (`<name>.mscz.bak`, overwritten on repeat use) since this writes raw
// zip/JSON/XML rather than going through MuseScore's own save path.
pub fn apply(
    musescore_path: &Path,
    sfz_path: &str,
    part_ids: &[String],
    articulation_mapping: &HashMap<String, String>,
    default_articulation_id: &str,
) -> Result<ApplyResult, String> {
    if part_ids.is_empty() {
        return Err("no tracks selected".to_string());
    }
    if !Path::new(sfz_path).is_file() {
        return Err(format!("sfz file not found: {sfz_path}"));
    }

    let keyswitch = crate::sfz_write::build_keyswitch_variant(Path::new(sfz_path))?;
    let articulation_notes: HashMap<String, u8> = keyswitch
        .notes
        .iter()
        .map(|n| (n.id.clone(), n.note))
        .collect();

    let mut entries = read_zip_entries(musescore_path)?;
    let settings_index = find_audiosettings(&entries)?;

    let mscx_index = entries
        .iter()
        .position(|(name, _)| name.ends_with(".mscx"))
        .ok_or_else(|| "no .mscx found inside this file".to_string())?;
    // Strict, not lossy - inject_keyswitches' byte offsets come from this
    // exact text via roxmltree, and a lossy replacement would change the
    // byte length, desyncing every offset from what gets spliced back in.
    let mscx_text = String::from_utf8(entries[mscx_index].1.clone())
        .map_err(|_| "the .mscx is not valid UTF-8".to_string())?;
    let inject_result = inject_keyswitches(
        &mscx_text,
        part_ids,
        articulation_mapping,
        default_articulation_id,
        &articulation_notes,
    )?;
    entries[mscx_index].1 = inject_result.mscx_text.into_bytes();

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
            "componentState": sfizz_component_state(&keyswitch.derived_path)
        }
    });

    let tracks = settings
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "audiosettings.json has no tracks array".to_string())?;

    // Drop any track left over from a previous apply's hidden keyswitch
    // staff (identified the same way as the mscx side - instrumentId
    // carries the KEYSWITCH_EID_PREFIX signature) before adding fresh
    // ones, same idempotency discipline as remove_previous_keyswitch_staves.
    tracks.retain(|t| {
        !t.get("instrumentId")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with(KEYSWITCH_EID_PREFIX))
    });

    // The real/visible track is muted, not silenced note-by-note - the
    // hidden keyswitch staff now carries a full copy of the actual
    // performance (see inject_keyswitches), so the real track would just
    // double every note otherwise. Confirmed necessary: two Parts given
    // identical sfizz plugin state do NOT share internal switch state -
    // attempting that actually silenced the real part's own audio
    // entirely. Muting the real track and making the hidden one the sole
    // audible source sidesteps the cross-instance problem rather than
    // solving it.
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
            obj.insert(
                "soloMuteState".to_string(),
                serde_json::json!({ "mute": true, "solo": false })
            );
        }
        applied += 1;
    }

    // Give each new hidden keyswitch staff its OWN Mixer track entry,
    // pointed at the SAME sfizz+derived-sfz assignment - its own separate
    // plugin instance is fine here, since this staff's own content
    // contains everything it needs (switch + real notes together), with
    // no dependency on sharing state with the muted real track.
    //
    // instrumentId here MUST match the Instrument id actually written
    // into the mscx (mscx_instrument_id from inject_keyswitches) -
    // confirmed by hand that this, not partId, is what MuseScore's Mixer
    // uses to bind a track entry to a score instrument: manually
    // assigning a sound via the Mixer to one of these staves made
    // MuseScore create a brand new track entry keyed by that exact
    // Instrument id, leaving our old entry (which used a different,
    // made-up instrumentId string) untouched and unused - which is
    // exactly why these staves fell back to MS Basic before this fix.
    // auxSends mirrors the real tracks' own reverb send, since this
    // staff is now the one actually heard.
    //
    // Inserted before the metronome's track entry, not appended at the
    // very end - the metronome has no <Part> of its own in the mscx
    // (it's a Mixer-only channel MuseScore appends programmatically
    // after every real document Part), so appending straight onto the
    // end would leave this array's order one group out of step with the
    // actual Part order.
    let insert_at = tracks
        .iter()
        .position(|t| t.get("instrumentId").and_then(Value::as_str) == Some("metronome"))
        .unwrap_or(tracks.len());
    for (offset, (new_part_id, mscx_instrument_id)) in inject_result.new_parts.iter().enumerate() {
        tracks.insert(insert_at + offset, serde_json::json!({
            "in": sfizz_in,
            "instrumentId": mscx_instrument_id,
            "out": {
                "auxSends": [
                    { "active": true, "signalAmount": 0.30000001192092896 },
                    { "active": true, "signalAmount": 0.30000001192092896 }
                ],
                "balance": 0,
                "fxChain": {},
                "volumeDb": 0
            },
            "partId": new_part_id,
            "soloMuteState": {
                "mute": false,
                "solo": false
            }
        }));
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
        keyswitch_sfz_path: keyswitch.derived_path,
    })
}
