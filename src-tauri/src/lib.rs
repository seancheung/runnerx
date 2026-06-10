mod commands;
mod config;
mod error;
mod manifest;
mod runner;
mod sandbox;
mod scanner;

use std::sync::Arc;

use runner::RunnerState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(Arc::new(RunnerState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::list_scripts,
            commands::default_scripts_root,
            commands::read_script,
            commands::read_script_files,
            commands::read_readme,
            commands::run_script,
            commands::run_install,
            commands::run_uninstall,
            commands::run_uninstall_with_base,
            commands::cancel_run,
            commands::current_run,
            commands::manifest_schema,
            commands::validate_manifest,
            commands::get_config,
            commands::set_config,
            commands::write_script_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
