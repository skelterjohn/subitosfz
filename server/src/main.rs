use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use axum::{http::StatusCode, routing::get, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

mod chunk;
mod musescore;
mod sf2;
mod sfz_parse;
mod sfz_write;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Deserialize)]
struct Sf2PresetsRequest {
    path: String,
}

#[derive(Serialize)]
struct Sf2PresetsResponse {
    presets: Vec<sf2::PresetSummary>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

async fn sf2_presets(
    Json(req): Json<Sf2PresetsRequest>,
) -> Result<Json<Sf2PresetsResponse>, (StatusCode, Json<ErrorResponse>)> {
    sf2::list_presets(&PathBuf::from(req.path))
        .map(|presets| Json(Sf2PresetsResponse { presets }))
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct Sf2ExportRequest {
    path: String,
    #[serde(rename = "presetIndex")]
    preset_index: usize,
    #[serde(rename = "destDir")]
    dest_dir: String,
    #[serde(rename = "instrumentName")]
    instrument_name: String,
}

async fn sf2_export(
    Json(req): Json<Sf2ExportRequest>,
) -> Result<Json<sf2::ExportResult>, (StatusCode, Json<ErrorResponse>)> {
    sf2::export_preset(
        &PathBuf::from(req.path),
        req.preset_index,
        &PathBuf::from(req.dest_dir),
        &req.instrument_name,
    )
    .map(Json)
    .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct SfzParseRequest {
    path: String,
}

async fn sfz_parse_handler(
    Json(req): Json<SfzParseRequest>,
) -> Result<Json<sfz_parse::ParsedSfz>, (StatusCode, Json<ErrorResponse>)> {
    sfz_parse::parse(&PathBuf::from(req.path))
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct ChunkRequest {
    #[serde(rename = "sfzPath")]
    sfz_path: String,
    #[serde(rename = "sourcePath")]
    source_path: String,
    #[serde(rename = "baseName")]
    base_name: String,
}

#[derive(Serialize)]
struct ChunkResponse {
    chunks: Vec<chunk::ChunkSummary>,
}

async fn chunk_handler(
    Json(req): Json<ChunkRequest>,
) -> Result<Json<ChunkResponse>, (StatusCode, Json<ErrorResponse>)> {
    chunk::chunk_wav(
        &PathBuf::from(req.sfz_path),
        &PathBuf::from(req.source_path),
        &req.base_name
    )
    .map(|chunks| Json(ChunkResponse { chunks }))
    .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct AddRegionRequest {
    #[serde(rename = "workingSfzPath")]
    working_sfz_path: String,
    #[serde(rename = "originalSfzPath")]
    original_sfz_path: String,
    #[serde(rename = "samplePath")]
    sample_path: String,
    note: u8,
    lokey: u8,
    hikey: u8,
    lovel: u8,
    hivel: u8,
    pan: i32,
    #[serde(rename = "articulationId")]
    articulation_id: String,
    #[serde(rename = "articulationLabel")]
    articulation_label: Option<String>,
}

async fn add_region_handler(
    Json(req): Json<AddRegionRequest>,
) -> Result<Json<sfz_parse::ParsedSfz>, (StatusCode, Json<ErrorResponse>)> {
    sfz_write::append_region(
        &PathBuf::from(req.working_sfz_path),
        &PathBuf::from(req.original_sfz_path),
        &req.sample_path,
        req.note,
        req.lokey,
        req.hikey,
        req.lovel,
        req.hivel,
        req.pan,
        &req.articulation_id,
        req.articulation_label.as_deref()
    )
    .map(Json)
    .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct SetOpcodeRequest {
    #[serde(rename = "workingSfzPath")]
    working_sfz_path: String,
    #[serde(rename = "originalSfzPath")]
    original_sfz_path: String,
    #[serde(rename = "regionIndex")]
    region_index: usize,
    name: String,
    value: String,
}

async fn set_opcode_handler(
    Json(req): Json<SetOpcodeRequest>,
) -> Result<Json<sfz_parse::ParsedSfz>, (StatusCode, Json<ErrorResponse>)> {
    sfz_write::set_region_opcode(
        &PathBuf::from(req.working_sfz_path),
        &PathBuf::from(req.original_sfz_path),
        req.region_index,
        &req.name,
        &req.value
    )
    .map(Json)
    .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct OpcodePair {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct SetCellOpcodesRequest {
    #[serde(rename = "workingSfzPath")]
    working_sfz_path: String,
    #[serde(rename = "regionIndices")]
    region_indices: Vec<usize>,
    opcodes: Vec<OpcodePair>,
}

async fn set_cell_opcodes_handler(
    Json(req): Json<SetCellOpcodesRequest>,
) -> Result<Json<sfz_parse::ParsedSfz>, (StatusCode, Json<ErrorResponse>)> {
    let opcodes: Vec<(String, String)> = req.opcodes.into_iter().map(|o| (o.name, o.value)).collect();
    sfz_write::set_cell_opcodes(&PathBuf::from(req.working_sfz_path), &req.region_indices, &opcodes)
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct DeleteRegionRequest {
    #[serde(rename = "workingSfzPath")]
    working_sfz_path: String,
    #[serde(rename = "regionIndex")]
    region_index: usize,
}

async fn delete_region_handler(
    Json(req): Json<DeleteRegionRequest>,
) -> Result<Json<sfz_parse::ParsedSfz>, (StatusCode, Json<ErrorResponse>)> {
    sfz_write::delete_region(&PathBuf::from(req.working_sfz_path), req.region_index)
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct CreateNewRequest {
    #[serde(rename = "destDir")]
    dest_dir: String,
    #[serde(rename = "fileName")]
    file_name: String,
}

#[derive(Serialize)]
struct CreateNewResponse {
    #[serde(rename = "sfzPath")]
    sfz_path: String,
}

async fn create_new_handler(
    Json(req): Json<CreateNewRequest>,
) -> Result<Json<CreateNewResponse>, (StatusCode, Json<ErrorResponse>)> {
    sfz_write::create_new(&PathBuf::from(req.dest_dir), &req.file_name)
        .map(|sfz_path| Json(CreateNewResponse { sfz_path }))
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct OpenRequest {
    #[serde(rename = "originalPath")]
    original_path: String,
    #[serde(rename = "workingPath")]
    working_path: String,
}

async fn open_handler(
    Json(req): Json<OpenRequest>,
) -> Result<Json<sfz_parse::ParsedSfz>, (StatusCode, Json<ErrorResponse>)> {
    sfz_write::open_working_copy(&PathBuf::from(req.original_path), &PathBuf::from(req.working_path))
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct SaveRequest {
    #[serde(rename = "workingPath")]
    working_path: String,
    #[serde(rename = "originalPath")]
    original_path: String,
}

async fn save_handler(
    Json(req): Json<SaveRequest>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    sfz_write::save(&PathBuf::from(req.working_path), &PathBuf::from(req.original_path))
        .map(|()| StatusCode::OK)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct MuseScoreInspectRequest {
    path: String,
}

async fn musescore_inspect_handler(
    Json(req): Json<MuseScoreInspectRequest>,
) -> Result<Json<musescore::MuseScoreInfo>, (StatusCode, Json<ErrorResponse>)> {
    musescore::inspect(&PathBuf::from(req.path))
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct MuseScoreApplyRequest {
    #[serde(rename = "museScorePath")]
    musescore_path: String,
    #[serde(rename = "sfzPath")]
    sfz_path: String,
    #[serde(rename = "partIds")]
    part_ids: Vec<String>,
    #[serde(rename = "articulationMapping", default)]
    articulation_mapping: HashMap<String, String>,
    #[serde(rename = "defaultArticulationId", default)]
    default_articulation_id: String,
}

async fn musescore_apply_handler(
    Json(req): Json<MuseScoreApplyRequest>,
) -> Result<Json<musescore::ApplyResult>, (StatusCode, Json<ErrorResponse>)> {
    musescore::apply(
        &PathBuf::from(req.musescore_path),
        &req.sfz_path,
        &req.part_ids,
        &req.articulation_mapping,
        &req.default_articulation_id
    )
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        .route("/sf2/presets", post(sf2_presets))
        .route("/sf2/export", post(sf2_export))
        .route("/sfz/parse", post(sfz_parse_handler))
        .route("/sfz/new", post(create_new_handler))
        .route("/sfz/open", post(open_handler))
        .route("/sfz/save", post(save_handler))
        .route("/audio/chunk", post(chunk_handler))
        .route("/sfz/add-region", post(add_region_handler))
        .route("/sfz/set-opcode", post(set_opcode_handler))
        .route("/sfz/set-cell-opcodes", post(set_cell_opcodes_handler))
        .route("/sfz/delete-region", post(delete_region_handler))
        .route("/musescore/inspect", post(musescore_inspect_handler))
        .route("/musescore/apply", post(musescore_apply_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
        );

    // Bind to port 0 so the OS picks a free port, then announce it on stdout
    // so the Electron parent process knows where to send requests.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind local port");
    let port = listener.local_addr().unwrap().port();

    println!("SUBITOSFZ_SERVER_PORT={port}");
    std::io::stdout().flush().ok();

    axum::serve(listener, app).await.expect("server error");
}
