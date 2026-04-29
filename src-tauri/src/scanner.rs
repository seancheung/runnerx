use crate::error::{Result, RxError};
use crate::manifest::{Manifest, PlatformId};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// JSON state file written after a successful install.
const INSTALL_STATE_FILE: &str = ".runnerx-installed.json";
/// Pre-sandbox empty marker; still recognized as "host installed" for backward compat.
const LEGACY_MARKER: &str = ".runnerx-installed";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    Host,
    Sandbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    pub version: u32,
    pub kind: InstallKind,
    /// For sandbox: the docker image ref produced by `docker commit`.
    pub image: Option<String>,
    /// For sandbox: the base image name from manifest.sandbox.image.
    pub base_image: Option<String>,
    pub installed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    pub id: String,
    pub dir: String,
    pub manifest: Manifest,
    pub installed: bool,
    pub install_state: Option<InstallState>,
    /// Optional inline image data url for the icon. Loaded eagerly so the
    /// frontend can show it without an extra round-trip per script.
    pub icon_data_url: Option<String>,
    pub readme_path: Option<String>,
    /// Platforms this manifest declares a block for. The UI uses this to flag
    /// multi-platform scripts and to gray out scripts that can't run here.
    pub supported_platforms: Vec<PlatformId>,
    /// True if `supported_platforms` contains the OS we're running on.
    pub supported_on_current_platform: bool,
}

/// Scan a single root directory; each immediate subdirectory containing a
/// `manifest.yaml` (or `.yml`) is a script. Errors for individual entries are
/// returned alongside the successful ones so a single broken manifest does not
/// hide the others.
pub fn scan_root(root: &Path) -> (Vec<ScriptInfo>, Vec<ScanError>) {
    let mut scripts = Vec::new();
    let mut errors = Vec::new();

    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            errors.push(ScanError {
                dir: root.display().to_string(),
                message: format!("read root: {e}"),
            });
            return (scripts, errors);
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with('.')) {
            continue;
        }
        match load_script(&path) {
            Ok(info) => scripts.push(info),
            Err(e) => errors.push(ScanError {
                dir: path.display().to_string(),
                message: e.to_string(),
            }),
        }
    }

    scripts.sort_by(|a, b| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()));
    (scripts, errors)
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanError {
    pub dir: String,
    pub message: String,
}

pub fn load_script(dir: &Path) -> Result<ScriptInfo> {
    let manifest_path = find_manifest_file(dir).ok_or_else(|| RxError::NotFound(dir.display().to_string()))?;
    let raw = fs::read_to_string(&manifest_path)?;
    let manifest: Manifest = serde_yaml::from_str(&raw).map_err(|e| RxError::BadManifest {
        dir: dir.display().to_string(),
        message: e.to_string(),
    })?;

    let id = manifest
        .id
        .clone()
        .or_else(|| dir.file_name().and_then(|n| n.to_str()).map(String::from))
        .ok_or_else(|| RxError::BadManifest {
            dir: dir.display().to_string(),
            message: "cannot derive id".into(),
        })?;

    let supported_platforms = manifest.supported_platforms();
    if supported_platforms.is_empty() {
        return Err(RxError::BadManifest {
            dir: dir.display().to_string(),
            message: "manifest must declare at least one platform block (`macos` or `windows`)".into(),
        });
    }
    let supported_on_current_platform = PlatformId::current()
        .map(|p| supported_platforms.contains(&p))
        .unwrap_or(false);

    let install_state = read_install_state(dir);
    let installed = install_state.is_some();
    let icon_data_url = manifest
        .icon
        .as_deref()
        .and_then(|rel| load_icon(&dir.join(rel)));
    let readme_path = resolve_readme(dir, manifest.readme.as_deref()).map(|p| p.display().to_string());

    Ok(ScriptInfo {
        id,
        dir: dir.display().to_string(),
        manifest,
        installed,
        install_state,
        icon_data_url,
        readme_path,
        supported_platforms,
        supported_on_current_platform,
    })
}

fn find_manifest_file(dir: &Path) -> Option<PathBuf> {
    for name in ["manifest.yaml", "manifest.yml"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn resolve_readme(dir: &Path, configured: Option<&str>) -> Option<PathBuf> {
    if let Some(rel) = configured {
        let p = dir.join(rel);
        return p.is_file().then_some(p);
    }
    for name in ["README.md", "readme.md", "Readme.md"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn load_icon(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 512 * 1024 {
        return None; // skip large icons
    }
    let mime = match path.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        _ => return None,
    };
    use base64_lite::encode;
    Some(format!("data:{mime};base64,{}", encode(&bytes)))
}

// minimal base64 encoder so we don't need another crate
mod base64_lite {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
        let mut i = 0;
        while i + 3 <= input.len() {
            let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
            out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
            out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
            out.push(ALPHA[(n & 0x3f) as usize] as char);
            i += 3;
        }
        let rem = input.len() - i;
        if rem == 1 {
            let n = (input[i] as u32) << 16;
            out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        } else if rem == 2 {
            let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
            out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
            out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        out
    }
}

pub fn install_state_path(dir: &Path) -> PathBuf {
    dir.join(INSTALL_STATE_FILE)
}

pub fn legacy_marker_path(dir: &Path) -> PathBuf {
    dir.join(LEGACY_MARKER)
}

pub fn read_install_state(dir: &Path) -> Option<InstallState> {
    let json_path = install_state_path(dir);
    if json_path.is_file() {
        if let Ok(content) = fs::read_to_string(&json_path) {
            if let Ok(state) = serde_json::from_str::<InstallState>(&content) {
                return Some(state);
            }
        }
    }
    if legacy_marker_path(dir).is_file() {
        return Some(InstallState {
            version: 1,
            kind: InstallKind::Host,
            image: None,
            base_image: None,
            installed_at: None,
        });
    }
    None
}

pub fn write_install_state(dir: &Path, state: &InstallState) -> Result<()> {
    let json = serde_json::to_string_pretty(state)?;
    fs::write(install_state_path(dir), json)?;
    // Clean up the legacy empty marker if it lingers from a previous version.
    let legacy = legacy_marker_path(dir);
    if legacy.exists() {
        let _ = fs::remove_file(&legacy);
    }
    Ok(())
}

pub fn clear_install_state(dir: &Path) -> Result<()> {
    let json_path = install_state_path(dir);
    if json_path.exists() {
        fs::remove_file(&json_path)?;
    }
    let legacy = legacy_marker_path(dir);
    if legacy.exists() {
        fs::remove_file(&legacy)?;
    }
    Ok(())
}

pub fn current_iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // crude RFC3339 formatter (UTC) without pulling in chrono
    // 1970-01-01 00:00:00 UTC + secs
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let h = rem / 3_600;
    let m = (rem % 3_600) / 60;
    let s = rem % 60;
    let (year, month, day) = days_to_ymd(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

fn days_to_ymd(mut days: i64) -> (i64, u32, u32) {
    // 1970-01-01 is day 0
    let mut year: i64 = 1970;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if leap { 366 } else { 365 };
        if days < days_in_year { break; }
        days -= days_in_year;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let months: [u32; 12] = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month: u32 = 1;
    let mut d = days as u32;
    for &len in &months {
        if d < len { break; }
        d -= len;
        month += 1;
    }
    (year, month, d + 1)
}
