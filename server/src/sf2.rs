// Import support for SF2/SF3: list the presets in a soundfont, and export
// one chosen preset as a standalone .sfz + extracted sample files.
//
// Scope deliberately kept to the common/basic feature set discussed for
// this tool: key/velocity ranges, loop points, pan, tune, volume envelope,
// and overall attenuation. SF2's preset-level generator zones (which modify
// instrument generators via an offset/additive scheme) are NOT honored -
// only the instrument-level zones (global + specific) are merged. This
// covers the overwhelming majority of real-world presets, which rarely use
// preset-level generator overrides beyond selecting an instrument.
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use soundfont::{raw::GeneratorType, Instrument, SoundFont2, Zone};

#[derive(Serialize)]
pub struct PresetSummary {
    pub index: usize,
    pub name: String,
    pub bank: u16,
    pub program: u16,
}

#[derive(Serialize)]
pub struct ExportResult {
    pub sfz_path: String,
    pub sample_count: usize,
}

fn load(path: &Path) -> Result<SoundFont2, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("failed to open file: {e}"))?;
    SoundFont2::load(&mut file).map_err(|e| format!("failed to parse soundfont: {e:?}"))
}

pub fn list_presets(path: &Path) -> Result<Vec<PresetSummary>, String> {
    let sf2 = load(path)?;
    Ok(sf2
        .presets
        .iter()
        .enumerate()
        .map(|(index, p)| PresetSummary {
            index,
            name: p.header.name.clone(),
            bank: p.header.bank,
            program: p.header.preset,
        })
        .collect())
}

// A zone's own generators, keyed by the raw generator id so lookups are
// simple. Never pre-merged with the instrument's global zone - see
// instrument_sample_zones for why.
type GenMap = BTreeMap<u16, i32>;

fn generator_amount_as_i32(generator: &soundfont::raw::Generator) -> Option<i32> {
    use soundfont::raw::GeneratorAmount;
    match &generator.amount {
        GeneratorAmount::I16(v) => Some(*v as i32),
        GeneratorAmount::U16(v) => Some(*v as i32),
        GeneratorAmount::Range(_) => None,
    }
}

fn zone_gen_map(zone: &Zone) -> GenMap {
    let mut map = GenMap::new();
    for generator in &zone.gen_list {
        if let Some(v) = generator_amount_as_i32(generator) {
            map.insert(generator.ty.as_raw(), v);
        }
    }
    map
}

fn get(map: &GenMap, ty: GeneratorType) -> Option<i32> {
    map.get(&(ty as u16)).copied()
}

fn timecents_to_seconds(tc: i32) -> f64 {
    2f64.powf(tc as f64 / 1200.0)
}

fn centibels_to_db(cb: i32) -> f64 {
    cb as f64 / 10.0
}

// Converts an SF2 "sustain attenuation in centibels" value (0 = full
// volume, higher = quieter) into SFZ's ampeg_sustain percent (100 = full
// volume, 0 = silence).
fn centibels_to_sustain_percent(cb: i32) -> f64 {
    let db = centibels_to_db(cb);
    (100.0 * 10f64.powf(-db / 20.0)).clamp(0.0, 100.0)
}

fn pan_to_percent(raw: i32) -> f64 {
    (raw as f64 / 500.0 * 100.0).clamp(-100.0, 100.0)
}

fn sample_modes_to_loop_mode(sample_modes: i32) -> Option<&'static str> {
    match sample_modes {
        1 => Some("loop_continuous"),
        3 => Some("loop_sustain"),
        _ => None,
    }
}

// Extracts the opcodes that only depend on a bare (unmerged) generator map -
// envelope, pan, tune, volume, loop mode. Called once on the global zone's
// map to build <global>, and once per region on that zone's own map to
// build its <region> - a region that doesn't set a generator itself simply
// omits the line here, correctly inheriting whatever <global> provided via
// normal SFZ cascading, with no merging needed on our end.
fn optional_opcode_lines(gens: &GenMap) -> Vec<(&'static str, String)> {
    let mut lines = Vec::new();

    if let Some(p) = get(gens, GeneratorType::Pan) {
        lines.push(("pan", format!("{:.1}", pan_to_percent(p))));
    }

    let coarse_tune = get(gens, GeneratorType::CoarseTune);
    let fine_tune = get(gens, GeneratorType::FineTune);
    if coarse_tune.is_some() || fine_tune.is_some() {
        let tune_cents = coarse_tune.unwrap_or(0) * 100 + fine_tune.unwrap_or(0);
        if tune_cents != 0 {
            lines.push(("tune", tune_cents.to_string()));
        }
    }

    if let Some(a) = get(gens, GeneratorType::InitialAttenuation) {
        let volume_db = -centibels_to_db(a);
        if volume_db.abs() > 0.01 {
            lines.push(("volume", format!("{volume_db:.2}")));
        }
    }

    if let Some(a) = get(gens, GeneratorType::AttackVolEnv) {
        lines.push(("ampeg_attack", format!("{:.4}", timecents_to_seconds(a))));
    }
    if let Some(h) = get(gens, GeneratorType::HoldVolEnv) {
        lines.push(("ampeg_hold", format!("{:.4}", timecents_to_seconds(h))));
    }
    if let Some(d) = get(gens, GeneratorType::DecayVolEnv) {
        lines.push(("ampeg_decay", format!("{:.4}", timecents_to_seconds(d))));
    }
    if let Some(s) = get(gens, GeneratorType::SustainVolEnv) {
        lines.push(("ampeg_sustain", format!("{:.2}", centibels_to_sustain_percent(s))));
    }
    if let Some(r) = get(gens, GeneratorType::ReleaseVolEnv) {
        lines.push(("ampeg_release", format!("{:.4}", timecents_to_seconds(r))));
    }

    if let Some(mode) = get(gens, GeneratorType::SampleModes).and_then(sample_modes_to_loop_mode) {
        lines.push(("loop_mode", mode.to_string()));
    }

    lines
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' | ' ' => c,
            _ => '_',
        })
        .collect();
    let cleaned = cleaned.replace(' ', "_");
    if cleaned.is_empty() {
        "instrument".to_string()
    } else {
        cleaned
    }
}

struct SampleZone {
    key_lo: u8,
    key_hi: u8,
    vel_lo: u8,
    vel_hi: u8,
    sample_id: u16,
    // This zone's OWN generators only - deliberately not merged with the
    // instrument's global zone. Keeping them separate is what lets the SFZ
    // writer emit a real <global> header instead of flattening the same
    // resolved value onto every region (see optional_opcode_lines).
    gens: GenMap,
}

// Zone::key_range()/vel_range() in the soundfont crate call `as_i16()` on a
// generator amount that's actually stored as the `Range` variant, which
// panics. Read the range generators directly instead.
fn zone_range(zone: &Zone, ty: GeneratorType) -> Option<(u8, u8)> {
    zone.gen_list
        .iter()
        .find(|g| g.ty.into_result().ok() == Some(ty))
        .and_then(|g| g.amount.as_range())
        .map(|r| (r.low, r.high))
}

// Returns each sample zone plus the instrument's global zone generators
// separately (empty map if there is none) - callers resolve fallback
// (zone-own, else global) only where SFZ itself can't do it for them
// (root key, whether a region loops at all); everything else is handled by
// emitting <global> once and letting normal SFZ cascading do the rest.
fn instrument_sample_zones(instrument: &Instrument) -> (Vec<SampleZone>, GenMap) {
    let mut global_gens = GenMap::new();
    let mut global_key_range: Option<(u8, u8)> = None;
    let mut global_vel_range: Option<(u8, u8)> = None;
    let mut out = Vec::new();

    for (i, zone) in instrument.zones.iter().enumerate() {
        let sample_id = zone.sample();

        if sample_id.is_none() {
            // A zone with no sample reference is only meaningful as the
            // instrument's global zone, and only if it's first.
            if i == 0 {
                global_gens = zone_gen_map(zone);
                global_key_range = zone_range(zone, GeneratorType::KeyRange);
                global_vel_range = zone_range(zone, GeneratorType::VelRange);
            }
            continue;
        }
        let sample_id = *sample_id.unwrap();

        let gens = zone_gen_map(zone);
        let (key_lo, key_hi) = zone_range(zone, GeneratorType::KeyRange)
            .or(global_key_range)
            .unwrap_or((0, 127));
        let (vel_lo, vel_hi) = zone_range(zone, GeneratorType::VelRange)
            .or(global_vel_range)
            .unwrap_or((0, 127));

        out.push(SampleZone {
            key_lo,
            key_hi,
            vel_lo,
            vel_hi,
            sample_id,
            gens,
        });
    }

    (out, global_gens)
}

pub fn export_preset(
    path: &Path,
    preset_index: usize,
    dest_dir: &Path,
    instrument_name: &str,
) -> Result<ExportResult, String> {
    let sf2 = load(path)?;
    let preset = sf2
        .presets
        .get(preset_index)
        .ok_or_else(|| "preset index out of range".to_string())?;

    // Find the (first) instrument this preset references. Preset-level
    // generator overrides are intentionally not applied - see module docs.
    let instrument_id = preset
        .zones
        .iter()
        .find_map(|z| z.instrument())
        .ok_or_else(|| "preset has no instrument zone".to_string())?;
    let instrument = sf2
        .instruments
        .get(*instrument_id as usize)
        .ok_or_else(|| "instrument index out of range".to_string())?;

    let (zones, global_gens) = instrument_sample_zones(instrument);
    if zones.is_empty() {
        return Err("instrument has no sample zones".to_string());
    }
    let global_lines = optional_opcode_lines(&global_gens);

    let safe_name = sanitize_filename(instrument_name);
    let samples_dir = dest_dir.join(&safe_name);
    fs::create_dir_all(&samples_dir).map_err(|e| format!("failed to create directory: {e}"))?;

    let mut file = fs::File::open(path).map_err(|e| format!("failed to reopen file: {e}"))?;
    let raw_bytes = {
        use std::io::Read;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        buf
    };

    let smpl = sf2
        .sample_data
        .smpl
        .ok_or_else(|| "soundfont has no sample data".to_string())?;

    let mut sfz_regions = String::new();
    let mut sample_count = 0usize;

    for (i, zone) in zones.iter().enumerate() {
        let header = sf2
            .sample_headers
            .get(zone.sample_id as usize)
            .ok_or_else(|| "sample index out of range".to_string())?;

        let is_vorbis = header.sample_type.is_vorbis();
        let sample_file_name = format!(
            "{:03}_{}.{}",
            i,
            sanitize_filename(&header.name),
            if is_vorbis { "ogg" } else { "wav" }
        );
        let sample_path = samples_dir.join(&sample_file_name);

        if is_vorbis {
            let start = smpl.offset as usize + header.start as usize;
            let end = smpl.offset as usize + header.end as usize;
            let bytes = raw_bytes
                .get(start..end)
                .ok_or_else(|| "sample data out of range".to_string())?;
            fs::write(&sample_path, bytes).map_err(|e| e.to_string())?;
        } else {
            let pool_start = smpl.offset as usize;
            let start = pool_start + header.start as usize * 2;
            let end = pool_start + header.end as usize * 2;
            let pcm_bytes = raw_bytes
                .get(start..end)
                .ok_or_else(|| "sample data out of range".to_string())?;

            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: header.sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&sample_path, spec)
                .map_err(|e| format!("failed to create wav: {e}"))?;
            for chunk in pcm_bytes.chunks_exact(2) {
                let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                writer
                    .write_sample(sample)
                    .map_err(|e| format!("failed to write sample: {e}"))?;
            }
            writer.finalize().map_err(|e| e.to_string())?;
        }

        // Relative sample offset within the extracted file, for loop points.
        let rel_loop_start = header.loop_start.saturating_sub(header.start);
        let rel_loop_end = header.loop_end.saturating_sub(header.start);

        // Root key isn't something <global> can cover via the opcode-lines
        // helper (it's always a required per-region line, not an optional
        // one), so its own-zone-else-global fallback has to happen here.
        let root_key = get(&zone.gens, GeneratorType::OverridingRootKey)
            .or_else(|| get(&global_gens, GeneratorType::OverridingRootKey))
            .filter(|&v| v >= 0)
            .map(|v| v as u8)
            .unwrap_or(header.origpitch);

        // loop_start/loop_end are sample-frame offsets specific to this
        // exact audio file, so they're always per-region when present at
        // all - but "present at all" depends on the EFFECTIVE loop mode,
        // which might be inherited from <global> rather than set on this
        // zone, so that fallback (unlike the rest of optional_opcode_lines)
        // still has to be resolved here too.
        let loops = get(&zone.gens, GeneratorType::SampleModes)
            .or_else(|| get(&global_gens, GeneratorType::SampleModes))
            .and_then(sample_modes_to_loop_mode)
            .is_some();

        sfz_regions.push_str("<region>\n");
        sfz_regions.push_str(&format!("sample={safe_name}/{sample_file_name}\n"));
        sfz_regions.push_str(&format!("lokey={}\n", zone.key_lo));
        sfz_regions.push_str(&format!("hikey={}\n", zone.key_hi));
        sfz_regions.push_str(&format!("lovel={}\n", zone.vel_lo));
        sfz_regions.push_str(&format!("hivel={}\n", zone.vel_hi));
        sfz_regions.push_str(&format!("pitch_keycenter={root_key}\n"));
        // Only this zone's own overrides - anything it doesn't set itself
        // is inherited from <global> via normal SFZ cascading, not
        // re-resolved and reprinted here.
        for (name, value) in optional_opcode_lines(&zone.gens) {
            sfz_regions.push_str(&format!("{name}={value}\n"));
        }
        if loops {
            sfz_regions.push_str(&format!("loop_start={rel_loop_start}\n"));
            sfz_regions.push_str(&format!("loop_end={rel_loop_end}\n"));
        }
        sfz_regions.push('\n');

        sample_count += 1;
    }

    let mut global_block = String::new();
    if !global_lines.is_empty() {
        global_block.push_str("<global>\n");
        for (name, value) in &global_lines {
            global_block.push_str(&format!("{name}={value}\n"));
        }
        global_block.push('\n');
    }

    let sfz_text = format!(
        "// Imported from {} - preset \"{}\"\n\n{}{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
        preset.header.name,
        global_block,
        sfz_regions
    );

    let sfz_path = dest_dir.join(format!("{safe_name}.sfz"));
    fs::write(&sfz_path, sfz_text).map_err(|e| format!("failed to write sfz: {e}"))?;

    Ok(ExportResult {
        sfz_path: sfz_path.to_string_lossy().to_string(),
        sample_count,
    })
}
