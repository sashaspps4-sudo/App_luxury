mod browsers;
#[cfg(any(target_os = "macos", test))]
mod sealed_storage;
#[cfg(target_os = "macos")]
mod macos_storage;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(target_os = "windows")]
#[link(name = "Crypt32")]
extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        optional_entropy: *const DataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        optional_entropy: *const DataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "Kernel32")]
extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(target_os = "windows")]
const SESSION_ENTROPY: &[u8] = b"LuxuryMailerSession-v1";

#[cfg(target_os = "windows")]
fn protect_session(value: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    let input = DataBlob {
        cb_data: value.len() as u32,
        pb_data: value.as_ptr() as *mut u8,
    };
    let entropy = DataBlob {
        cb_data: SESSION_ENTROPY.len() as u32,
        pb_data: SESSION_ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };

    let result = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0x1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0x1,
                &mut output,
            )
        }
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let bytes = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe { LocalFree(output.pb_data.cast()); }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn protect_session(value: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    macos_storage::protect(value, protect)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn protect_session(_value: &[u8], _protect: bool) -> Result<Vec<u8>, String> {
    Err("Защищённое хранение сессии поддерживается в Windows и macOS.".to_string())
}

fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("license.session"))
        .map_err(|error| error.to_string())
}

fn settings_directory(base: &Path) -> PathBuf {
    base.join("configs")
}

fn read_settings_file(directory: &Path) -> Result<Option<String>, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Не удалось создать папку конфигураций: {error}"))?;
    let path = directory.join("settings.json");
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Не удалось прочитать конфигурации: {error}")),
    }
}

fn write_settings_file(directory: &Path, contents: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| format!("Конфигурация содержит некорректный JSON: {error}"))?;
    if !parsed.is_object()
        || !parsed
            .get("configs")
            .is_some_and(serde_json::Value::is_object)
    {
        return Err("Ожидался JSON-файл с объектом configs.".to_string());
    }

    fs::create_dir_all(directory)
        .map_err(|error| format!("Не удалось создать папку конфигураций: {error}"))?;
    fs::write(directory.join("settings.json"), contents)
        .map_err(|error| format!("Не удалось сохранить конфигурации: {error}"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    read_settings_file(&settings_directory(&base))
}

#[tauri::command]
fn save_settings(app: AppHandle, contents: String) -> Result<(), String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    write_settings_file(&settings_directory(&base), &contents)
}

fn validate_automation(contents: &str) -> Result<serde_json::Value, String> {
    if contents.len() > 4096 { return Err("Настройки автоматизации слишком большие.".into()); }
    let mut value: serde_json::Value = serde_json::from_str(contents).map_err(|e| e.to_string())?;
    if value["checkEverySeconds"].is_null() {
        if let Some(minutes) = value["checkEveryMinutes"].as_u64() {
            value["checkEverySeconds"] = minutes.checked_mul(60).ok_or("Некорректный интервал проверки.")?.into();
        }
    }
    if let Some(object) = value.as_object_mut() { object.remove("checkEveryMinutes"); }
    for (key, max) in [("delayMinSeconds",86400), ("delayMaxSeconds",86400), ("checkEverySent",10000), ("checkEverySeconds",86400), ("maxPerProfile",100000), ("pauseEverySent",10000), ("pauseSeconds",86400)] {
        if value[key].as_u64().filter(|number| *number <= max).is_none() { return Err("Некорректные настройки автоматизации.".into()); }
    }
    if value["delayMinSeconds"].as_u64() > value["delayMaxSeconds"].as_u64()
        || (value["pauseEverySent"].as_u64().unwrap() > 0 && value["pauseSeconds"] == 0)
        || !matches!(value["afterQueue"].as_str(), Some("finish" | "monitor"))
        || (value["afterQueue"] == "monitor" && value["checkEverySeconds"] == 0) {
        return Err("Проверьте диапазон задержки, время перерыва и интервал проверки входящих.".into());
    }
    Ok(value)
}

#[tauri::command]
fn load_automation(app: AppHandle) -> Result<Option<String>, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("automation.json");
    match fs::read_to_string(path) {
        Ok(contents) => { validate_automation(&contents)?; Ok(Some(contents)) },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn automation_value(app: &AppHandle) -> Result<serde_json::Value, String> {
    let contents = load_automation(app.clone())?.unwrap_or_else(|| include_str!("../../browser-runtime/automation-defaults.json").to_string());
    validate_automation(&contents)
}

#[tauri::command]
fn save_automation(app: AppHandle, contents: String) -> Result<(), String> {
    validate_automation(&contents)?;
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let temporary = directory.join("automation.tmp");
    fs::write(&temporary, contents).map_err(|e| e.to_string())?;
    fs::rename(temporary, directory.join("automation.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_license_session(app: AppHandle, token: String) -> Result<(), String> {
    if token.len() < 32 || token.len() > 160 || token.chars().any(char::is_whitespace) {
        return Err("Сервер вернул некорректную сессию.".to_string());
    }
    let path = session_file(&app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Не удалось определить папку приложения.".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let protected = protect_session(token.as_bytes(), true)?;
    let temporary = path.with_extension("session.tmp");
    fs::write(&temporary, protected).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_license_session(app: AppHandle) -> Result<Option<String>, String> {
    let path = session_file(&app)?;
    let protected = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let token = protect_session(&protected, false)?;
    String::from_utf8(token)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_license_session(app: AppHandle) -> Result<(), String> {
    let path = session_file(&app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(browsers::BrowserState::default())
        .setup(|app| {
            let base = app.path().app_config_dir()?;
            fs::create_dir_all(settings_directory(&base))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            browsers::start_browsers,
            browsers::stop_browsers,
            browsers::browser_status,
            browsers::check_accounts,
            browsers::campaign_events,
            browsers::campaign_template,
            browsers::start_campaign,
            browsers::sync_inboxes,
            browsers::confirm_inbox_baseline,
            browsers::prepare_parser_batch,
            browsers::active_browser_run,
            browsers::store_parser_batch,
            browsers::load_profiles,
            browsers::end_browser_session,
            browsers::save_profiles,
            browsers::delete_profile,
            load_settings,
            load_automation,
            save_automation,
            save_settings,
            save_license_session,
            load_license_session,
            clear_license_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Luxury Mailer");
}

#[cfg(test)]
mod tests {
    use super::{read_settings_file, write_settings_file};
    use std::time::{SystemTime, UNIX_EPOCH};
    #[test]
    fn automation_validates_ranges_and_monitoring_requirements() {
        let mut value = super::validate_automation(include_str!("../../browser-runtime/automation-defaults.json")).unwrap();
        let mut old = value.clone();
        old.as_object_mut().unwrap().remove("checkEverySeconds");
        old["checkEveryMinutes"] = 2.into();
        assert_eq!(super::validate_automation(&old.to_string()).unwrap()["checkEverySeconds"], 120);
        value["delayMinSeconds"] = 10.into();
        assert!(super::validate_automation(&value.to_string()).is_err());
        value["delayMaxSeconds"] = 20.into();
        assert!(super::validate_automation(&value.to_string()).is_ok());
        value["afterQueue"] = "monitor".into();
        value["checkEverySeconds"] = 0.into();
        assert!(super::validate_automation(&value.to_string()).is_err());
    }

    #[test]
    fn settings_file_round_trips_and_creates_its_directory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "luxury-settings-test-{}-{nonce}",
            std::process::id()
        ));
        let contents = r#"{"version":1,"selectedConfig":"Default","configs":{"Default":{"apiKey":"test-secret"}}}"#;

        write_settings_file(&directory, contents).unwrap();
        assert_eq!(
            read_settings_file(&directory).unwrap().as_deref(),
            Some(contents)
        );

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_json_is_not_saved() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "luxury-settings-invalid-test-{}-{nonce}",
            std::process::id()
        ));
        assert!(write_settings_file(&directory, "not json").is_err());
        assert!(!directory.exists());
    }
}
