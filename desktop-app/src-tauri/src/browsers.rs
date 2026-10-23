use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct BrowserProfile {
    id: String,
    proxy: String,
    #[serde(default, rename = "directoryId", skip_serializing_if = "Option::is_none")]
    directory_id: Option<String>,
}

#[tauri::command]
pub fn load_profiles(app: AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("profiles.dat");
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(super::protect_session(&bytes, false)?)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn save_profiles(app: AppHandle, contents: String) -> Result<(), String> {
    if contents.len() > 200000 {
        return Err("Слишком большой список профилей.".into());
    }
    let value: serde_json::Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    let profiles: Vec<BrowserProfile> =
        serde_json::from_value(value["profiles"].clone()).map_err(|e| e.to_string())?;
    validate_profiles(&profiles)?;
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    std::fs::write(
        directory.join("profiles.dat"),
        super::protect_session(contents.as_bytes(), true)?,
    )
    .map_err(|e| e.to_string())
}

fn valid_profile_id(id: &str) -> bool {
    (!id.is_empty() && id.len() <= 9 && id.bytes().all(|c| c.is_ascii_digit()) && !id.starts_with('0'))
        || (id.len() == 36 && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) { c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) }
        }) && id.as_bytes()[14] == b'4' && b"89ab".contains(&id.as_bytes()[19]))
}

fn validate_profiles(profiles: &[BrowserProfile]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    let mut directories = std::collections::HashSet::new();
    if profiles.len() > 20 || profiles.iter().any(|p| {
        !valid_profile_id(&p.id) || !ids.insert(&p.id) || p.proxy.len() > 2048
            || !valid_profile_id(p.directory_id.as_deref().unwrap_or(&p.id))
            || !directories.insert(p.directory_id.as_deref().unwrap_or(&p.id))
    }) { return Err("Некорректный список профилей.".into()); }
    Ok(())
}

#[derive(Default)]
pub struct BrowserState {
    children: Arc<Mutex<Vec<Child>>>,
    statuses: Arc<Mutex<Arc<Mutex<Vec<serde_json::Value>>>>>,
    session: Arc<Mutex<Option<serde_json::Value>>>,
    inbox_results: Arc<Mutex<std::collections::HashMap<String, serde_json::Value>>>,
    campaign_events: Arc<Mutex<Vec<serde_json::Value>>>,
}

fn remove_profile_directory(root: &std::path::Path, id: &str) -> Result<(), String> {
    validate_profiles(&[BrowserProfile {
        id: id.into(),
        proxy: String::new(),
        directory_id: None,
    }])?;
    let target = root.join(format!("profile-{id}"));
    if !root.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&target);
    if matches!(&metadata, Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(());
    }
    let metadata = metadata.map_err(|e| e.to_string())?;
    let root_metadata = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    let mut linked = metadata.file_type().is_symlink() || root_metadata.file_type().is_symlink();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        linked |= (metadata.file_attributes() | root_metadata.file_attributes()) & 0x400 != 0;
    }
    let resolved_root = root.canonicalize().map_err(|e| e.to_string())?;
    let resolved_target = target.canonicalize().map_err(|e| e.to_string())?;
    if linked
        || !metadata.is_dir()
        || resolved_target.parent() != Some(resolved_root.as_path())
        || resolved_target.file_name() != target.file_name()
    {
        return Err("Папка профиля находится вне каталога профилей или является ссылкой.".into());
    }
    std::fs::remove_dir_all(&resolved_target).map_err(|e| {
        format!("Не удалось удалить данные профиля. Закройте его браузер и повторите: {e}")
    })
}

#[tauri::command]
pub async fn delete_profile(
    app: AppHandle,
    state: State<'_, BrowserState>,
    id: String,
    contents: String,
) -> Result<(), String> {
    let children = state.children.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = children.lock().map_err(|e| e.to_string())?;
        for process in guard.iter_mut() {
            if process.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Err("Сначала закройте браузеры текущей сессии.".into());
            }
        }
        if contents.len() > 200000 {
            return Err("Слишком большой список профилей.".into());
        }
        let value: serde_json::Value =
            serde_json::from_str(&contents).map_err(|e| e.to_string())?;
        let profiles: Vec<BrowserProfile> =
            serde_json::from_value(value["profiles"].clone()).map_err(|e| e.to_string())?;
        validate_profiles(&profiles)?;
        if profiles.iter().any(|p| p.id == id) {
            return Err("Удаляемый профиль остался в списке.".into());
        }
        let protected = super::protect_session(contents.as_bytes(), true)?;
        let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let temporary = directory.join("profiles.delete.tmp");
        std::fs::write(&temporary, protected).map_err(|e| e.to_string())?;
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("browser-profiles");
        let old: serde_json::Value = serde_json::from_str(&load_profiles(app.clone())?.ok_or("Список профилей не найден.")?).map_err(|e| e.to_string())?;
        let existing = old["profiles"].as_array().and_then(|items| items.iter().find(|p| p["id"].as_str() == Some(id.as_str()))).ok_or("Профиль не найден.")?;
        let directory_id = existing["directoryId"].as_str().unwrap_or(&id);
        remove_profile_directory(&root, directory_id)?;
        // Keep the prepared snapshot until the metadata update succeeds.
        let prepared = std::fs::read(&temporary).map_err(|e| e.to_string())?;
        std::fs::write(directory.join("profiles.dat"), prepared).map_err(|e| {
            format!("Данные сессии удалены, но список не сохранён. Повторите удаление: {e}")
        })?;
        let _ = std::fs::remove_file(temporary);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn browser_status(state: State<BrowserState>) -> Vec<serde_json::Value> {
    state.statuses.lock().unwrap().lock().unwrap().clone()
}

fn stamp_session_end(
    session: &Arc<Mutex<Option<serde_json::Value>>>,
    statuses: &Arc<Mutex<Vec<serde_json::Value>>>,
    run_id: &str,
) {
    let finished = statuses.lock().map(|items| !items.is_empty() && items.iter().all(|p| p["status"] == "closed" || p["status"] == "error")).unwrap_or(false);
    if !finished { return; }
    if let Ok(mut guard) = session.lock() {
        if let Some(run) = guard.as_mut().filter(|run| run["runId"].as_str() == Some(run_id)) {
            if !run["endedAtMs"].is_number() {
                if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
                    run["endedAtMs"] = (now.as_millis() as u64).into();
                }
            }
        }
    }
}

fn create_run_snapshot(contents: &str, name: &str) -> Result<serde_json::Value, String> {
    let store: serde_json::Value = serde_json::from_str(contents).map_err(|e| e.to_string())?;
    let config = store
        .get("configs")
        .and_then(|configs| configs.get(name))
        .filter(|v| v.is_object())
        .ok_or_else(|| "Выбранный конфиг не найден. Сохраните его в настройках.".to_string())?;
    if !matches!(
        config["workflowMode"].as_str(),
        Some("broadcast" | "funnel")
    ) {
        return Err("В конфиге не указан корректный режим рассылки.".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(
        serde_json::json!({"runId": format!("{}-{nonce}", std::process::id()), "configName": name, "config": config, "startedAtMs": (nonce / 1_000_000) as u64}),
    )
}

#[tauri::command]
pub async fn start_browsers(
    app: AppHandle,
    state: State<'_, BrowserState>,
    profiles: Vec<BrowserProfile>,
    config_name: String,
) -> Result<serde_json::Value, String> {
    let children = state.children.clone();
    let shared_statuses = state.statuses.clone();
    let session = state.session.clone();
    let inbox_results = state.inbox_results.clone();
    let campaign_events = state.campaign_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
    validate_profiles(&profiles)?;
    if profiles.is_empty() {
        return Err("Допустимо от 1 до 20 профилей. Проверьте длину адресов прокси.".into());
    }
    let mut guard = children.lock().unwrap();
    for child in guard.iter_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("Браузеры уже запущены. Сначала остановите текущую сессию.".into());
        }
    }
    guard.clear();
    let config_base = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let contents = super::read_settings_file(&super::settings_directory(&config_base))?
        .ok_or_else(|| "Сначала сохраните конфиг рассылки в настройках.".to_string())?;
    let snapshot = create_run_snapshot(&contents, &config_name)?;
    let packaged_macos = cfg!(target_os = "macos") && !cfg!(debug_assertions);
    let macos_runtime = app.path().resource_dir().map_err(|e| e.to_string())?.join("macos-runtime");
    let runtime = if packaged_macos {
        macos_runtime.join("browser-runtime")
    } else if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../browser-runtime")
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("browser-runtime")
    };
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("browser-profiles");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let statuses = Arc::new(Mutex::new(profiles.iter().enumerate().map(|(index, p)| serde_json::json!({"index":index,"id":p.id,"status":"starting","message":""})).collect::<Vec<_>>()));
    *shared_statuses.lock().unwrap() = statuses.clone();
    *session.lock().unwrap() = Some(snapshot.clone());
    {
    let node = if packaged_macos { macos_runtime.join("bin/node") } else { std::path::PathBuf::from("node") };
    let mut command = Command::new(node);
    if packaged_macos {
        command.env("LUXURY_LINK_EXECUTABLE", macos_runtime.join("bin/luxury-link"));
        command.env("PLAYWRIGHT_BROWSERS_PATH", macos_runtime.join("chromium"));
        command.env("PLAYWRIGHT_SKIP_BROWSER_GC", "1");
    }
    command.arg(runtime.join("worker.mjs")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            for slot in statuses.lock().unwrap().iter_mut() { slot["status"] = "error".into(); }
            stamp_session_end(&session, &statuses, snapshot["runId"].as_str().unwrap_or_default());
            return Err("Не удалось запустить процесс браузеров. Проверьте Node.js.".into());
        },
    };
    let config = serde_json::json!({"profiles": profiles, "directory": directory, "run": snapshot});
    if writeln!(child.stdin.as_mut().unwrap(), "{config}").is_err() {
        let _ = child.kill(); let _ = child.wait();
        for slot in statuses.lock().unwrap().iter_mut() { slot["status"] = "error".into(); }
        stamp_session_end(&session, &statuses, snapshot["runId"].as_str().unwrap_or_default());
        return Err("Не удалось передать параметры браузерам.".into());
    }
    // Each reader owns its session's statuses, so a late EOF from an old worker
    // cannot overwrite the statuses of a new launch.
    let statuses = statuses.clone();
    let inbox_results = inbox_results.clone();
    let campaign_events = campaign_events.clone();
    let reader_session = session.clone();
    let reader_profiles = profiles.clone();
    let run_id = snapshot["runId"].as_str().unwrap().to_string();
    let output = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&line) {
                let Some(index) = reader_profiles.iter().position(|p| Some(p.id.as_str()) == value["id"].as_str()) else { continue; };
                let profile_id = reader_profiles[index].id.clone();
                if value["runId"].as_str() != Some(run_id.as_str()) { continue; }
                if value["type"] == "inbox" {
                    inbox_results.lock().unwrap().insert(profile_id.clone(), value);
                    continue;
                }
                if value["type"] == "campaign" {
                    value["index"] = index.into();
                    if let Some(slot) = statuses.lock().unwrap().get_mut(index) {
                        slot["campaignPhase"] = value["phase"].clone();
                        if value["sent"].is_number() { slot["sent"] = value["sent"].clone(); }
                    }
                    let mut events = campaign_events.lock().unwrap();
                    events.push(value);
                    if events.len() > 500 { events.remove(0); }
                    continue;
                }
                value["index"] = index.into();
                if let Some(slot) = statuses.lock().unwrap().get_mut(index) {
                    if value.get("sent").is_none() { value["sent"] = slot["sent"].clone(); }
                    if value.get("campaignPhase").is_none() { value["campaignPhase"] = slot["campaignPhase"].clone(); }
                    *slot = value;
                }
                stamp_session_end(&reader_session, &statuses, &run_id);
            }
        }
        for slot in statuses.lock().unwrap().iter_mut() {
            if slot["status"] != "closed" && slot["status"] != "error" {
                slot["status"] = "error".into();
                slot["message"] = "Процесс браузеров завершился. Проверьте зависимости browser-runtime.".into();
            }
        }
        stamp_session_end(&reader_session, &statuses, &run_id);
    });
    guard.push(child);
    }
    stamp_session_end(&session, &statuses, snapshot["runId"].as_str().unwrap_or_default());
    Ok(serde_json::json!({"runId": snapshot["runId"], "configName": snapshot["configName"], "mode": snapshot["config"]["workflowMode"], "startedAtMs": snapshot["startedAtMs"]}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn stop_browsers(state: State<BrowserState>) -> Result<(), String> {
    if let Some(run) = state.session.lock().map_err(|e| e.to_string())?.as_mut() { run["stopRequested"] = true.into(); }
    let mut guard = state.children.lock().unwrap();
    for child in guard.iter_mut() {
        if let Some(mut input) = child.stdin.take() {
            let _ = writeln!(input, "stop");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn active_browser_run(state: State<BrowserState>) -> Option<serde_json::Value> {
    state.session.lock().ok()?.as_ref().map(|run| serde_json::json!({
        "runId": run["runId"], "configName": run["configName"], "mode": run["config"]["workflowMode"],
        "startedAtMs": run["startedAtMs"], "endedAtMs": run["endedAtMs"],
        "campaignStarted": run["campaignStarted"] == true, "stopRequested": run["stopRequested"] == true,
        "parserComplete": run.get("parserBatch").is_some() || (run["config"]["databaseSource"] == "custom" && run["inboxSynced"] == true)
    }))
}

#[tauri::command]
pub async fn end_browser_session(state: State<'_, BrowserState>) -> Result<(), String> {
    let children = state.children.clone();
    let session = state.session.clone();
    let statuses = state.statuses.lock().map_err(|e| e.to_string())?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut processes = children.lock().map_err(|e| e.to_string())?;
        for child in processes.iter_mut() {
            if let Some(mut input) = child.stdin.take() { let _ = writeln!(input, "stop"); }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let mut running = false;
            for child in processes.iter_mut() { running |= child.try_wait().map_err(|e| e.to_string())?.is_none(); }
            if !running || std::time::Instant::now() >= deadline { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        for child in processes.iter_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { continue; }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let result = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
                if !result.status.success() && child.try_wait().map_err(|e| e.to_string())?.is_none() { return Err("Не удалось остановить сценарии. Повторите выход.".into()); }
            }
            #[cfg(not(target_os = "windows"))]
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
        }
        processes.clear();
        *session.lock().map_err(|e| e.to_string())? = None;
        for slot in statuses.lock().map_err(|e| e.to_string())?.iter_mut() { slot["status"] = "closed".into(); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn campaign_events(state: State<BrowserState>) -> Vec<serde_json::Value> {
    state.campaign_events.lock().unwrap().drain(..).collect()
}

#[tauri::command]
pub fn campaign_template(state: State<BrowserState>, run_id: String) -> Result<serde_json::Value, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let run = session.as_ref().ok_or("Нет активного запуска.")?;
    if run["runId"].as_str() != Some(run_id.as_str()) { return Err("Запуск изменился.".into()); }
    let config = &run["config"];
    if config["subjectLines"].as_str().unwrap_or("").trim().is_empty() { return Err("Заполните варианты темы письма в конфиге и создайте новый запуск.".into()); }
    if config["workflowMode"] == "funnel" {
        let key = config["serviceCode"].as_str().unwrap_or("");
        let text = config["templates"][key].as_str().filter(|value| !value.trim().is_empty())
            .or(config["templates"]["Default (Общие)"].as_str()).unwrap_or("");
        if text.trim().is_empty() { return Err("В конфиге нет текстов для воронки. Заполните их и создайте новый запуск.".into()); }
    }
    Ok(serde_json::json!({"mode":config["workflowMode"], "platform":config["previewPlatform"], "geo":config["previewGeo"]}))
}

#[tauri::command]
pub async fn start_campaign(app: AppHandle, state: State<'_, BrowserState>, run_id: String, html: Option<String>) -> Result<(), String> {
    let session = state.session.clone();
    let children = state.children.clone();
    let statuses = state.statuses.lock().map_err(|e| e.to_string())?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session.lock().map_err(|e| e.to_string())?;
        let run = guard.as_mut().ok_or("Нет активного запуска.")?;
        if run["runId"].as_str() != Some(run_id.as_str()) { return Err("Запуск изменился.".into()); }
        if run["campaignStarted"] == true { return Err("Очередь этого запуска уже передана воркерам. Повторная отправка запрещена.".into()); }
        if run["inboxSynced"] != true || !run["parserBatch"].is_object() { return Err("Сначала сохраните входящие и получите объявления.".into()); }
        let config = &run["config"];
        if config["subjectLines"].as_str().unwrap_or("").trim().is_empty() { return Err("Заполните варианты темы письма в конфиге и создайте новый запуск.".into()); }
        let content = {
            if config["previewPlatform"] == "Custom" { config["customHtml"].as_str().unwrap_or("").to_string() }
            else { html.unwrap_or_default() }
        };
        if content.trim().is_empty() || content.len() > 2_000_000 { return Err("HTML-шаблон пуст или превышает 2 МБ.".into()); }
        let automation = run["automation"].clone();
        let token = super::load_license_session(app)?.ok_or("Нет действующей локальной сессии лицензии.")?;
        let live = statuses.lock().map_err(|e| e.to_string())?;
        let opened: Vec<_> = live.iter().filter(|p| p["status"] != "closed" && p["status"] != "error").collect();
        if opened.is_empty() || opened.iter().any(|p| p["status"] != "ready") { return Err("Один из аккаунтов потерял готовность Gmail.".into()); }
        let mailboxes: serde_json::Map<String, serde_json::Value> = run["inboxSnapshots"].as_array().ok_or("Нет отпечатков входящих.")?.iter().filter_map(|p| Some((p["profile_id"].as_str()?.to_string(), p["mailbox_email"].clone()))).collect();
        let request = serde_json::json!({"command":"campaign", "parserRequest":run["parserRequest"], "parserBatch":run["parserBatch"], "runId":run_id, "token":token, "mailboxes":mailboxes, "html":content, "automation":automation});
        // Set before the first dispatch: partial dispatch must never be replayed.
        run["campaignStarted"] = true.into();
        drop(live);
        drop(guard);
        let mut workers = children.lock().map_err(|e| e.to_string())?;
        for child in workers.iter_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                if let Some(input) = child.stdin.as_mut() { writeln!(input, "{request}").map_err(|_| "Не удалось передать очередь воркеру. Повторная отправка заблокирована.".to_string())?; }
            }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

fn initial_cycle_quota(automation: &serde_json::Value) -> u64 {
    let size = automation["checkEverySent"].as_u64().filter(|n| *n > 0).unwrap_or(10);
    let limit = automation["maxPerProfile"].as_u64().unwrap_or(0);
    if limit > 0 { size.min(limit) } else { size }
}

#[tauri::command]
pub fn prepare_parser_batch(
    app: AppHandle,
    state: State<BrowserState>,
    run_id: String,
) -> Result<serde_json::Value, String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    let run = session.as_mut().ok_or("Нет активного запуска.")?;
    if run["runId"].as_str() != Some(run_id.as_str()) {
        return Err("Запуск изменился. Повторите проверку аккаунтов.".into());
    }
    if run["inboxSynced"] != true {
        return Err("Сначала сохраните отпечаток входящих всех профилей на сервере.".into());
    }
    let config = &run["config"];
    if config["databaseSource"] == "custom" {
        return Ok(serde_json::json!({"source": "custom"}));
    }
    let shared = state.statuses.lock().map_err(|e| e.to_string())?.clone();
    let statuses = shared.lock().map_err(|e| e.to_string())?;
    let opened: Vec<_> = statuses.iter().filter(|p| p["status"] != "closed" && p["status"] != "error").collect();
    if opened.is_empty() || opened.iter().any(|p| p["status"] != "ready") {
        return Err("Сначала подтвердите готовность всех открытых аккаунтов.".into());
    }
    let key = config["parserApi"].as_str().unwrap_or("").trim();
    if key.is_empty() {
        return Err("Укажите API-ключ VVSPARSER в конфиге и создайте новый запуск.".into());
    }
    let platform = config["serviceCode"].as_str().or(config["platform"].as_str()).unwrap_or("").to_ascii_lowercase();
    let ids: Vec<_> = opened.iter().map(|p| p["id"].clone()).collect();
    let automation = super::automation_value(&app)?;
    let quota = initial_cycle_quota(&automation);
    let limits: serde_json::Map<String, serde_json::Value> = opened.iter().map(|p| (p["id"].as_str().unwrap().to_string(), quota.into())).collect();
    let request = serde_json::json!({
        "run_id": run_id, "platform": platform, "profile_ids": ids,
        "api_key": key, "countries": config["selectedGeos"], "filters": config["parserFilters"], "profile_limits": limits
    });
    run["parserRequest"] = request.clone();
    run["automation"] = automation;
    Ok(serde_json::json!({"source": "parser", "request": request}))
}

#[tauri::command]
pub fn store_parser_batch(
    state: State<BrowserState>,
    result: serde_json::Value,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    let run = session.as_mut().ok_or("Нет активного запуска.")?;
    if result["run_id"] != run["runId"] || !result["batches"].is_array() {
        return Err("Ответ парсера относится к другому запуску.".into());
    }
    // Retain the profile assignments with the captured run for the sending stage.
    run["parserBatch"] = result;
    Ok(())
}

#[tauri::command]
pub async fn sync_inboxes(state: State<'_, BrowserState>, run_id: String) -> Result<serde_json::Value, String> {
    let children = state.children.clone();
    let shared = state.statuses.lock().map_err(|e| e.to_string())?.clone();
    let inbox_results = state.inbox_results.clone();
    let session = state.session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let guard = session.lock().map_err(|e| e.to_string())?;
            let run = guard.as_ref().ok_or("Нет активного запуска.")?;
            if run["runId"].as_str() != Some(run_id.as_str()) { return Err("Запуск изменился.".into()); }
            if run["inboxSynced"] == true {
                return Ok(serde_json::json!({"run_id": run_id, "profiles": run["inboxSnapshots"]}));
            }
        }
        let profiles: Vec<String> = {
            let statuses = shared.lock().map_err(|e| e.to_string())?;
            let open: Vec<_> = statuses.iter().filter(|p| p["status"] != "closed" && p["status"] != "error").collect();
            if open.is_empty() || open.iter().any(|p| p["status"] != "ready") { return Err("Сначала подтвердите готовность аккаунтов.".into()); }
            open.iter().filter_map(|p| p["id"].as_str().map(str::to_string)).collect()
        };
        let request_id = format!("inbox-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos());
        let request = serde_json::json!({"command":"inbox", "requestId":request_id});
        {
            let mut guard = children.lock().map_err(|e| e.to_string())?;
            for child in guard.iter_mut() {
                if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                    if let Some(input) = child.stdin.as_mut() { writeln!(input, "{request}").map_err(|e| e.to_string())?; }
                }
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            let results = inbox_results.lock().map_err(|e| e.to_string())?;
            let mut snapshots = Vec::new();
            for id in &profiles {
                if let Some(result) = results.get(id).filter(|r| r["requestId"] == request_id && r["runId"] == run_id) {
                    if let Some(error) = result["error"].as_str() { return Err(format!("Профиль {id}: {error}")); }
                    snapshots.push(result["snapshot"].clone());
                }
            }
            drop(results);
            if snapshots.len() == profiles.len() {
                let mut guard = session.lock().map_err(|e| e.to_string())?;
                let run = guard.as_mut().ok_or("Запуск завершён.")?;
                if run["runId"].as_str() != Some(run_id.as_str()) { return Err("Запуск изменился.".into()); }
                run["inboxSnapshots"] = serde_json::json!(snapshots);
                return Ok(serde_json::json!({"run_id":run_id, "profiles":snapshots}));
            }
            if shared.lock().map_err(|e| e.to_string())?.iter().any(|p| profiles.iter().any(|id| p["id"].as_str() == Some(id.as_str())) && (p["status"] == "closed" || p["status"] == "error" || p["status"] == "unready")) {
                return Err("Один из аккаунтов закрылся или потерял вход в Gmail.".into());
            }
            if std::time::Instant::now() >= deadline { return Err("Не удалось снять отпечаток за 5 минут. Повторите проверку.".into()); }
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn confirm_inbox_baseline(state: State<BrowserState>, run_id: String) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    let run = session.as_mut().ok_or("Нет активного запуска.")?;
    if run["runId"].as_str() != Some(run_id.as_str()) || !run["inboxSnapshots"].is_array() {
        return Err("Отпечаток не соответствует текущему запуску.".into());
    }
    run["inboxSynced"] = true.into();
    Ok(())
}

#[tauri::command]
pub async fn check_accounts(
    state: State<'_, BrowserState>,
) -> Result<Vec<serde_json::Value>, String> {
    let children = state.children.clone();
    let statuses = state.statuses.lock().unwrap().clone();
    let session = state
        .session
        .lock()
        .unwrap()
        .clone()
        .ok_or("Нет активного запуска.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let request_id = format!(
            "{}-{}",
            session["runId"].as_str().unwrap_or_default(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        );
        if statuses
            .lock()
            .unwrap()
            .iter()
            .any(|p| p["status"] == "starting")
        {
            return Err("Дождитесь открытия браузеров.".into());
        }
        let request = serde_json::json!({"command":"check", "requestId":request_id});
        {
            let mut guard = children.lock().unwrap();
            for child in guard.iter_mut() {
                if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                    if let Some(input) = child.stdin.as_mut() {
                        let _ = writeln!(input, "{request}");
                    }
                }
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        loop {
            let result = statuses.lock().unwrap().clone();
            if result.iter().all(|p| {
                p["status"] == "closed"
                    || p["status"] == "error"
                    || (p["checkId"].as_str() == Some(request_id.as_str())
                        && matches!(p["status"].as_str(), Some("ready" | "unready")))
            }) {
                return Ok(result);
            }
            if std::time::Instant::now() >= deadline {
                return Err(
                    "Браузер не ответил на проверку. Повторите проверку готовности.".into(),
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_parser_cycle_obeys_sending_interval_and_run_limit() {
        for (interval, limit, expected) in [(10, 25, 10), (10, 5, 5), (10, 0, 10), (0, 25, 10), (0, 3, 3), (0, 0, 10), (25, 100, 25)] {
            assert_eq!(super::initial_cycle_quota(&serde_json::json!({"checkEverySent": interval, "maxPerProfile": limit})), expected);
        }
    }

    #[test]
    fn session_end_waits_for_last_profile_and_ignores_old_runs() {
        let session = Arc::new(Mutex::new(Some(serde_json::json!({"runId":"current", "startedAtMs":1}))));
        let statuses = Arc::new(Mutex::new(vec![serde_json::json!({"status":"closed"}), serde_json::json!({"status":"ready"})]));
        stamp_session_end(&session, &statuses, "current");
        assert!(session.lock().unwrap().as_ref().unwrap()["endedAtMs"].is_null());
        statuses.lock().unwrap()[1]["status"] = "closed".into();
        stamp_session_end(&session, &statuses, "old");
        assert!(session.lock().unwrap().as_ref().unwrap()["endedAtMs"].is_null());
        stamp_session_end(&session, &statuses, "current");
        let end = session.lock().unwrap().as_ref().unwrap()["endedAtMs"].as_u64().unwrap();
        stamp_session_end(&session, &statuses, "current");
        assert_eq!(session.lock().unwrap().as_ref().unwrap()["endedAtMs"].as_u64(), Some(end));
    }
    #[test]
    fn run_captures_the_requested_config_and_rejects_missing_or_invalid_modes() {
        let contents = r#"{"selectedConfig":"Other","configs":{"Chosen":{"workflowMode":"funnel","templates":{"Default":"original"}},"Other":{"workflowMode":"broadcast"}}}"#;
        let run = create_run_snapshot(contents, "Chosen").unwrap();
        assert_eq!(run["configName"], "Chosen");
        assert_eq!(run["config"]["workflowMode"], "funnel");
        assert_eq!(run["config"]["templates"]["Default"], "original");
        assert!(run["runId"].as_str().is_some());
        assert!(run["startedAtMs"].as_u64().unwrap() > 0);
        assert!(create_run_snapshot(contents, "Missing").is_err());
        assert!(create_run_snapshot(
            r#"{"configs":{"Chosen":{"workflowMode":"wrong"}}}"#,
            "Chosen"
        )
        .is_err());
    }
    #[test]
    fn deletion_removes_only_the_selected_profile_and_rejects_parent_paths() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("luxury-delete-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(root.join("profile-1/Default")).unwrap();
        std::fs::create_dir_all(root.join("profile-3/Default")).unwrap();
        std::fs::write(root.join("profile-1/Default/Cookies"), "session-one").unwrap();
        std::fs::write(root.join("profile-3/Default/Cookies"), "session-three").unwrap();
        assert!(remove_profile_directory(&root, "../profile-3").is_err());
        remove_profile_directory(&root, "1").unwrap();
        assert!(!root.join("profile-1").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("profile-3/Default/Cookies")).unwrap(),
            "session-three"
        );
        remove_profile_directory(&root, "1").unwrap();
        // Both tested paths have been resolved beneath this generated test root.
        let resolved_root = root.canonicalize().unwrap();
        assert!(resolved_root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("luxury-delete-"));
        std::fs::remove_dir_all(resolved_root).unwrap();
    }
    #[test]
    fn profile_ids_are_unique_and_cannot_escape_the_profiles_directory() {
        let profile = |id: &str| BrowserProfile {
            id: id.into(),
            proxy: String::new(),
            directory_id: None,
        };
        assert!(validate_profiles(&[profile("1"), profile("3")]).is_ok());
        assert!(validate_profiles(&[profile("1"), profile("1")]).is_err());
        assert!(validate_profiles(&[profile("../other")]).is_err());
        assert!(validate_profiles(&[profile("01")]).is_err());
        assert!(validate_profiles(&[]).is_ok());
        let mut migrated = profile("c24f671d-4b92-48e8-962b-55820dde9057");
        migrated.directory_id = Some("3".into());
        assert!(validate_profiles(&[migrated]).is_ok());
        let mut unsafe_directory = profile("c24f671d-4b92-48e8-962b-55820dde9057");
        unsafe_directory.directory_id = Some("../other".into());
        assert!(validate_profiles(&[unsafe_directory]).is_err());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn profile_proxy_credentials_round_trip_through_windows_protection() {
        let contents =
            br#"{"profiles":[{"id":"3","proxy":"socks5://user:secret@host:1080"}],"nextId":4}"#;
        let encrypted = super::super::protect_session(contents, true).unwrap();
        assert!(!encrypted.windows(6).any(|part| part == b"secret"));
        assert_eq!(
            super::super::protect_session(&encrypted, false).unwrap(),
            contents
        );
    }
}
