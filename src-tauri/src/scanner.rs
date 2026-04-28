use crate::error::{Result, RxError};
use crate::manifest::Manifest;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const INSTALLED_MARKER: &str = ".runnerx-installed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    pub id: String,
    pub dir: String,
    pub manifest: Manifest,
    pub installed: bool,
    /// Optional inline image data url for the icon. Loaded eagerly so the
    /// frontend can show it without an extra round-trip per script.
    pub icon_data_url: Option<String>,
    pub readme_path: Option<String>,
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

    let installed = dir.join(INSTALLED_MARKER).exists();
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
        icon_data_url,
        readme_path,
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

pub fn installed_marker_path(dir: &Path) -> PathBuf {
    dir.join(INSTALLED_MARKER)
}
