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

// A zone's generators, merged with the instrument's global zone (if any)
// providing defaults. Keyed by the raw generator id so lookups are simple.
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

fn merged_gen_map(global: Option<&GenMap>, specific: &GenMap) -> GenMap {
    let mut map = global.cloned().unwrap_or_default();
    map.extend(specific.iter().map(|(k, v)| (*k, *v)));
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

fn instrument_sample_zones(instrument: &Instrument) -> Vec<SampleZone> {
    let mut global_gens: Option<GenMap> = None;
    let mut global_key_range: Option<(u8, u8)> = None;
    let mut global_vel_range: Option<(u8, u8)> = None;
    let mut out = Vec::new();

    for (i, zone) in instrument.zones.iter().enumerate() {
        let sample_id = zone.sample();

        if sample_id.is_none() {
            // A zone with no sample reference is only meaningful as the
            // instrument's global zone, and only if it's first.
            if i == 0 {
                global_gens = Some(zone_gen_map(zone));
                global_key_range = zone_range(zone, GeneratorType::KeyRange);
                global_vel_range = zone_range(zone, GeneratorType::VelRange);
            }
            continue;
        }
        let sample_id = *sample_id.unwrap();

        let gens = merged_gen_map(global_gens.as_ref(), &zone_gen_map(zone));
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

    out
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

    let zones = instrument_sample_zones(instrument);
    if zones.is_empty() {
        return Err("instrument has no sample zones".to_string());
    }

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

        let root_key = get(&zone.gens, GeneratorType::OverridingRootKey)
            .filter(|&v| v >= 0)
            .map(|v| v as u8)
            .unwrap_or(header.origpitch);

        let pan = get(&zone.gens, GeneratorType::Pan).map(pan_to_percent);
        let coarse_tune = get(&zone.gens, GeneratorType::CoarseTune).unwrap_or(0);
        let fine_tune = get(&zone.gens, GeneratorType::FineTune).unwrap_or(0);
        let tune_cents = coarse_tune * 100 + fine_tune;

        let attenuation_cb = get(&zone.gens, GeneratorType::InitialAttenuation).unwrap_or(0);
        let volume_db = -centibels_to_db(attenuation_cb);

        let attack = get(&zone.gens, GeneratorType::AttackVolEnv).map(timecents_to_seconds);
        let hold = get(&zone.gens, GeneratorType::HoldVolEnv).map(timecents_to_seconds);
        let decay = get(&zone.gens, GeneratorType::DecayVolEnv).map(timecents_to_seconds);
        let sustain =
            get(&zone.gens, GeneratorType::SustainVolEnv).map(centibels_to_sustain_percent);
        let release = get(&zone.gens, GeneratorType::ReleaseVolEnv).map(timecents_to_seconds);

        let sample_modes = get(&zone.gens, GeneratorType::SampleModes).unwrap_or(0);
        let loop_mode = match sample_modes {
            1 => Some("loop_continuous"),
            3 => Some("loop_sustain"),
            _ => None,
        };

        sfz_regions.push_str("<region>\n");
        sfz_regions.push_str(&format!("sample={safe_name}/{sample_file_name}\n"));
        sfz_regions.push_str(&format!("lokey={}\n", zone.key_lo));
        sfz_regions.push_str(&format!("hikey={}\n", zone.key_hi));
        sfz_regions.push_str(&format!("lovel={}\n", zone.vel_lo));
        sfz_regions.push_str(&format!("hivel={}\n", zone.vel_hi));
        sfz_regions.push_str(&format!("pitch_keycenter={root_key}\n"));
        if tune_cents != 0 {
            sfz_regions.push_str(&format!("tune={tune_cents}\n"));
        }
        if let Some(p) = pan {
            sfz_regions.push_str(&format!("pan={p:.1}\n"));
        }
        if volume_db.abs() > 0.01 {
            sfz_regions.push_str(&format!("volume={volume_db:.2}\n"));
        }
        if let Some(a) = attack {
            sfz_regions.push_str(&format!("ampeg_attack={a:.4}\n"));
        }
        if let Some(h) = hold {
            sfz_regions.push_str(&format!("ampeg_hold={h:.4}\n"));
        }
        if let Some(d) = decay {
            sfz_regions.push_str(&format!("ampeg_decay={d:.4}\n"));
        }
        if let Some(s) = sustain {
            sfz_regions.push_str(&format!("ampeg_sustain={s:.2}\n"));
        }
        if let Some(r) = release {
            sfz_regions.push_str(&format!("ampeg_release={r:.4}\n"));
        }
        if let Some(mode) = loop_mode {
            sfz_regions.push_str(&format!("loop_mode={mode}\n"));
            sfz_regions.push_str(&format!("loop_start={rel_loop_start}\n"));
            sfz_regions.push_str(&format!("loop_end={rel_loop_end}\n"));
        }
        sfz_regions.push('\n');

        sample_count += 1;
    }

    let sfz_text = format!(
        "// Imported from {} - preset \"{}\"\n\n{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
        preset.header.name,
        sfz_regions
    );

    let sfz_path = dest_dir.join(format!("{safe_name}.sfz"));
    fs::write(&sfz_path, sfz_text).map_err(|e| format!("failed to write sfz: {e}"))?;

    Ok(ExportResult {
        sfz_path: sfz_path.to_string_lossy().to_string(),
        sample_count,
    })
}
