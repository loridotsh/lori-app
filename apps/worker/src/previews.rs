//! Fixed, read-only document preview jobs. No model commands or workspace writes.
use super::*;
use base64::Engine;

/// Most pages a job may carry. The API never leases more, and a worker that is
/// told otherwise refuses the job rather than render an unbounded range.
const MAX_WINDOW: u32 = 8;
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
/// One job's pages share a request body, so a heavy window is split across jobs.
const MAX_JOB_BYTES: usize = 10 * 1024 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
/// How long to wait before looking again when the API cannot hold a request open for us.
const IDLE_POLL: Duration = Duration::from_millis(250);
/// How long one request to the API's wait-for-work endpoint asks to be held.
const WAIT_MS: u64 = 8_000;
/// Converted documents kept, so later windows of the same file skip the Office conversion
/// that is most of the cost of a job. Bounded by count and by bytes.
const CACHE_ENTRIES: usize = 6;
const CACHE_BYTES: usize = 96 * 1024 * 1024;
const CACHE_ENTRY_BYTES: usize = 32 * 1024 * 1024;

/// PDFs converted from Office documents, newest first, keyed by the source file's hash.
static CONVERTED: std::sync::Mutex<Vec<(String, std::sync::Arc<Vec<u8>>)>> =
    std::sync::Mutex::new(Vec::new());

fn cached_pdf(sha256: &str) -> Option<std::sync::Arc<Vec<u8>>> {
    let mut cache = CONVERTED.lock().ok()?;
    let at = cache.iter().position(|(key, _)| key == sha256)?;
    let entry = cache.remove(at);
    let pdf = entry.1.clone();
    cache.insert(0, entry);
    Some(pdf)
}

fn remember_pdf(sha256: &str, pdf: Vec<u8>) {
    if pdf.is_empty() || pdf.len() > CACHE_ENTRY_BYTES {
        return;
    }
    let Ok(mut cache) = CONVERTED.lock() else {
        return;
    };
    cache.retain(|(key, _)| key != sha256);
    cache.insert(0, (sha256.to_string(), std::sync::Arc::new(pdf)));
    cache.truncate(CACHE_ENTRIES);
    while cache.iter().map(|(_, pdf)| pdf.len()).sum::<usize>() > CACHE_BYTES && cache.len() > 1 {
        cache.pop();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    #[serde(default)]
    project_id: Option<String>,
    id: String,
    lease: String,
    path: String,
    file_id: String,
    sha256: String,
    page: u32,
    /// Absent from an older API, which leases one page at a time.
    #[serde(default = "one")]
    count: u32,
}

fn one() -> u32 {
    1
}

/// Pages a rendered window can send, in order. The first page is mandatory:
/// the job leased it, so without it there is nothing to report. Later pages
/// that are missing, invalid or over budget are left for the API to queue again.
fn collect_pages<'a>(
    files: &[(&str, &'a [u8])],
    directory: &str,
    first: u32,
    count: u32,
) -> Result<Vec<(u32, &'a [u8])>> {
    let mut pages = Vec::new();
    let mut total = 0usize;
    for page in first..first + count {
        let expected = format!("{directory}/page-{page}.png");
        let image = files
            .iter()
            .find(|(path, _)| *path == expected)
            .map(|(_, bytes)| *bytes);
        match image {
            Some(bytes)
                if bytes.len() <= MAX_PAGE_BYTES
                    && bytes.starts_with(PNG_MAGIC)
                    && total + bytes.len() <= MAX_JOB_BYTES =>
            {
                total += bytes.len();
                pages.push((page, bytes));
            }
            _ if page == first => return Err("preview_page_missing"),
            _ => break,
        }
    }
    Ok(pages)
}

/// Looks for one job and runs it. `Ok(true)` means work was done, so the caller
/// should look again immediately instead of idling.
async fn next(client: &Client, config: &Config) -> Result<bool> {
    // Acquire capacity before leasing so an agent command cannot consume the
    // preview's lease while the preview merely waits for the sandbox.
    let _slot = EXECUTION_SLOT.lock().await;
    let response = post(
        client,
        config,
        "previews/claim",
        &config.secret,
        &json!({"workerId": config.worker_id, "projectScopes": true}),
    )
    .await?;
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(false);
    }
    let bytes = raw_bounded(response, 16 * 1024).await?;
    let job: Preview = serde_json::from_slice(&bytes).map_err(|_| "invalid_preview")?;
    for id in [&job.id, &job.lease, &job.file_id] {
        uuid::Uuid::parse_str(id).map_err(|_| "invalid_preview")?;
    }
    if !(1..=10000).contains(&job.page) || !(1..=MAX_WINDOW).contains(&job.count) {
        return Err("invalid_preview");
    }
    sandbox::relative(&job.path)?;
    // The same scratch-memory and execution lock as agent tool operations.
    let result = tokio::time::timeout(Duration::from_secs(75), async {
        let runner = config.sandbox.as_ref().ok_or("sandbox_unavailable")?;
        let mut scratch = sandbox::Scratch::new()?;
        let directory = format!("preview-{}", uuid::Uuid::new_v4());
        let extension = std::path::Path::new(&job.path).extension()
            .and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        let needs_conversion = extension != "pdf";
        // A document converted for an earlier window is reused: no download, no Office start-up.
        let cache_key = job.project_id.as_ref().map(|id| format!("{id}:{}:{}", job.file_id, job.sha256)).unwrap_or_else(|| job.sha256.clone());
        let (render_path, input) = if let Some(pdf) = needs_conversion.then(|| cached_pdf(&cache_key)).flatten() {
            let input = sandbox::Input { path: "preview.pdf".into(), file_id: job.file_id.clone(), sha256: sandbox::hash(&pdf) };
            scratch.stage(&input, &pdf)?;
            ("preview.pdf".to_string(), input)
        } else {
            let path = format!("previews/{}/input?lease={}", job.id, job.lease);
            let response = client.get(config.url(&path)?)
                .header(AUTHORIZATION, config.secret.clone()).send().await
                .map_err(|_| "preview_input_unavailable")?;
            let bytes = raw_bounded(response, sandbox::FILE_LIMIT).await?;
            let input = sandbox::Input { path: job.path.clone(), file_id: job.file_id.clone(), sha256: job.sha256.clone() };
            scratch.stage(&input, &bytes)?;
            if needs_conversion {
                let converted = format!("converted-{}", uuid::Uuid::new_v4());
                let conversion = sandbox::Execution {
                    kind: "document".into(), operation: "preview_document".into(),
                    arguments: json!({"path": job.path, "outputDirectory": converted, "timeoutSeconds": 50}),
                    inputs: vec![], outputs: vec![],
                };
                let outcome = runner.execute(&conversion, &scratch).await?;
                if outcome.failed { return Err("preview_conversion_failed"); }
                let target = format!("{converted}/preview.pdf");
                if let Some(pdf) = outcome.files.iter().find(|file| file.path == target) { remember_pdf(&cache_key, pdf.bytes.clone()); }
                (target, input)
            } else { (job.path.clone(), input) }
        };
        let execution = sandbox::Execution {
            kind: "document".into(), operation: "render_document".into(),
            arguments: json!({"path": render_path, "outputDirectory": directory,
                "startPage": job.page, "limit": job.count, "timeoutSeconds": 60}),
            inputs: vec![input], outputs: vec![],
        };
        let outcome = runner.execute(&execution, &scratch).await?;
        if outcome.failed { return Err("preview_render_failed"); }
        let total = outcome.output["totalPages"].as_u64().ok_or("invalid_preview_result")?;
        let files: Vec<(&str, &[u8])> = outcome.files.iter().map(|file| (file.path.as_str(), file.bytes.as_slice())).collect();
        let pages = collect_pages(&files, &directory, job.page, job.count)?;
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        // One page keeps the original request shape, which any API version accepts.
        Ok(if let [(_, image)] = pages.as_slice() {
            json!({"status": "ready", "totalPages": total, "image": encode(image)})
        } else {
            json!({"status": "ready", "totalPages": total,
                "pages": pages.iter().map(|(page, image)| json!({"page": page, "image": encode(image)})).collect::<Vec<_>>()})
        })
    }).await;
    let body = match result {
        Ok(Ok(body)) => body,
        Ok(Err(code)) => {
            eprintln!("cloud_preview_failed code={code}");
            json!({"status": "failed"})
        }
        Err(_) => {
            eprintln!("cloud_preview_failed code=preview_timeout");
            json!({"status": "failed"})
        }
    };
    accepted(
        post(
            client,
            config,
            &format!("previews/{}/complete?lease={}", job.id, job.lease),
            &config.secret,
            &body,
        )
        .await?,
    )
    .await?;
    Ok(true)
}

/// Holds a request open at the API until a page is queued. `Ok(true)` means work is waiting,
/// `Ok(false)` that nothing came within the wait. An API that has no such endpoint (an older
/// one) is reported as `preview_wait_unsupported`, and the caller polls instead.
async fn wait_for_work(client: &Client, config: &Config) -> Result<bool> {
    let response = post_within(
        client,
        config,
        "previews/wait",
        &config.secret,
        &json!({"workerId": config.worker_id, "waitMs": WAIT_MS}),
        Duration::from_millis(WAIT_MS) + Duration::from_secs(7),
    )
    .await?;
    match response.status() {
        StatusCode::NO_CONTENT => Ok(false),
        status if status.is_success() => Ok(true),
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => Err("preview_wait_unsupported"),
        _ => Err("preview_wait_failed"),
    }
}

pub async fn serve(
    client: Client,
    config: std::sync::Arc<Config>,
    mut shutdown: watch::Receiver<bool>,
) {
    if config.sandbox.is_none() {
        return;
    }
    let mut waiting = true;
    while !*shutdown.borrow() {
        if waiting {
            // Sleep inside the API's wait instead of polling: a page that is queued is picked up at once.
            let outcome = tokio::select! {
                _ = shutdown.changed() => break,
                outcome = wait_for_work(&client, &config) => outcome,
            };
            match outcome {
                Ok(true) => {}
                Ok(false) => continue,
                Err(code) => {
                    if code == "preview_wait_unsupported" {
                        waiting = false;
                    } else {
                        eprintln!("cloud_preview_stopped code={code}");
                    }
                    tokio::select! {
                        _ = shutdown.changed() => break,
                        _ = tokio::time::sleep(IDLE_POLL) => {}
                    }
                    continue;
                }
            }
        }
        let worked = tokio::select! {
            _ = shutdown.changed() => break,
            result = next(&client, &config) => match result {
                Ok(worked) => worked,
                Err(code) => { eprintln!("cloud_preview_stopped code={code}"); false }
            }
        };
        // A page was just rendered: more of the same window may be waiting, so
        // look again at once. Idle or failing, back off briefly so a queue the
        // worker cannot take (another worker has it) never turns into a busy loop.
        if worked {
            continue;
        }
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = tokio::time::sleep(if waiting { Duration::from_millis(100) } else { IDLE_POLL }) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(label: &str) -> Vec<u8> {
        [PNG_MAGIC, label.as_bytes()].concat()
    }
    fn file(page: u32, bytes: Vec<u8>) -> (String, Vec<u8>) {
        (format!("d/page-{page}.png"), bytes)
    }
    fn collect(files: &[(String, Vec<u8>)], first: u32, count: u32) -> Result<Vec<u32>> {
        let view: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
            .collect();
        collect_pages(&view, "d", first, count)
            .map(|pages| pages.into_iter().map(|(page, _)| page).collect())
    }
    #[test]
    fn a_window_reports_its_pages_in_order() {
        let files = vec![file(3, png("c")), file(2, png("b")), file(4, png("d"))];
        assert_eq!(collect(&files, 2, 3).unwrap(), vec![2, 3, 4]);
    }
    #[test]
    fn pages_past_the_end_of_the_document_are_simply_absent() {
        let files = vec![file(9, png("i")), file(10, png("j"))];
        assert_eq!(collect(&files, 9, 4).unwrap(), vec![9, 10]);
    }
    #[test]
    fn the_leased_first_page_is_mandatory() {
        assert!(collect(&[file(2, png("b"))], 1, 2).is_err());
        assert!(collect(&[file(1, b"<svg/>".to_vec())], 1, 1).is_err());
        assert!(collect(
            &[file(
                1,
                [PNG_MAGIC, vec![0u8; MAX_PAGE_BYTES].as_slice()].concat()
            )],
            1,
            1
        )
        .is_err());
    }
    #[test]
    fn later_bad_or_heavy_pages_are_left_for_the_api_to_queue_again() {
        let heavy = |label: &str| [png(label), vec![0u8; 4 * 1024 * 1024 - 64]].concat();
        let files = vec![
            file(1, heavy("a")),
            file(2, heavy("b")),
            file(3, heavy("c")),
            file(4, png("d")),
        ];
        // Two heavy pages fit the job budget; the third does not, and nothing after it is sent.
        assert_eq!(collect(&files, 1, 4).unwrap(), vec![1, 2]);
        let files = vec![
            file(1, png("a")),
            file(2, b"not a png".to_vec()),
            file(3, png("c")),
        ];
        assert_eq!(collect(&files, 1, 3).unwrap(), vec![1]);
    }
    #[test]
    fn converted_documents_are_remembered_newest_first_and_stay_bounded() {
        // The cache is process-wide, so use keys no other test touches.
        remember_pdf("cache-test-a", b"%PDF-a".to_vec());
        remember_pdf("cache-test-b", b"%PDF-b".to_vec());
        assert_eq!(cached_pdf("cache-test-a").unwrap().as_slice(), b"%PDF-a");
        assert!(cached_pdf("cache-test-missing").is_none());
        // Too large to keep, and empty, are both refused.
        remember_pdf("cache-test-big", vec![0u8; CACHE_ENTRY_BYTES + 1]);
        remember_pdf("cache-test-empty", Vec::new());
        assert!(cached_pdf("cache-test-big").is_none() && cached_pdf("cache-test-empty").is_none());
        // Past the entry limit the oldest are dropped.
        for n in 0..CACHE_ENTRIES + 2 {
            remember_pdf(&format!("cache-test-fill-{n}"), vec![1u8; 8]);
        }
        assert!(cached_pdf("cache-test-b").is_none());
        assert!(cached_pdf(&format!("cache-test-fill-{}", CACHE_ENTRIES + 1)).is_some());
        assert!(CONVERTED.lock().unwrap().len() <= CACHE_ENTRIES);
    }
    #[test]
    fn an_older_api_without_a_count_still_leases_one_page() {
        let job: Preview = serde_json::from_value(json!({
            "id": "a", "lease": "b", "path": "x.pdf", "fileId": "c", "sha256": "d", "page": 3
        }))
        .unwrap();
        assert_eq!(job.count, 1);
    }
}
