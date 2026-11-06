//! Offline Linux execution. Namespace setup or qualification failure disables
//! execution; this module never falls back to running a host command.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};

pub const FILE_LIMIT: usize = 20 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 64 * 1024 * 1024;
// The shared runtime can return a 2 MiB base64 thumbnail plus JSON metadata.
const OUTPUT_LIMIT: usize = 3 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub path: String,
    pub file_id: String,
    pub sha256: String,
}
#[derive(Deserialize)]
pub struct Execution {
    pub kind: String,
    pub operation: String,
    pub arguments: Value,
    pub inputs: Vec<Input>,
    #[serde(default)]
    pub outputs: Vec<String>,
}
pub struct OutputFile {
    pub path: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
}
pub struct Outcome {
    pub output: Value,
    pub failed: bool,
    pub files: Vec<OutputFile>,
}
#[derive(Clone, Copy)]
enum Backend {
    Bubblewrap,
    Helper,
}
pub struct Sandbox {
    runtime: PathBuf,
    python: PathBuf,
    backend: Backend,
    // The helper permits Office Unix IPC in the worker namespace. Model calls
    // may run concurrently, but two untrusted commands must never share it.
    execution_slot: tokio::sync::Mutex<()>,
}
#[cfg(unix)]
struct ProcessGroup {
    id: i32,
    active: std::sync::atomic::AtomicBool,
}
#[cfg(unix)]
impl ProcessGroup {
    fn kill(&self) {
        unsafe {
            if self.active.swap(false, std::sync::atomic::Ordering::AcqRel) {
                libc::kill(-self.id, libc::SIGKILL);
            }
        }
    }
}
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill();
    }
}
pub struct Scratch {
    directory: tempfile::TempDir,
    original: BTreeMap<String, String>,
}
type Result<T> = std::result::Result<T, &'static str>;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn relative(path: &str) -> Result<PathBuf> {
    if path.is_empty()
        || path.encode_utf16().count() > 240
        || path.contains('\\')
        || path.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        || path.starts_with('/')
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.starts_with(".lori-"))
    {
        return Err("invalid_execution_path");
    }
    let parsed = PathBuf::from(path);
    if parsed
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("invalid_execution_path");
    }
    Ok(parsed)
}
impl Scratch {
    pub fn new() -> Result<Self> {
        let directory = tempfile::tempdir().map_err(|_| "scratch_unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "scratch_unavailable")?;
        }
        std::fs::create_dir(directory.path().join("tmp")).map_err(|_| "scratch_unavailable")?;
        std::fs::create_dir(directory.path().join("files")).map_err(|_| "scratch_unavailable")?;
        Ok(Self {
            directory,
            original: BTreeMap::new(),
        })
    }
    pub fn stage(&mut self, input: &Input, bytes: &[u8]) -> Result<()> {
        if bytes.len() > FILE_LIMIT
            || hash(bytes) != input.sha256
            || self.original.contains_key(&input.path)
            || self.original.len() >= 100
        {
            return Err("invalid_execution_input");
        }
        let path = self
            .directory
            .path()
            .join("files")
            .join(relative(&input.path)?);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "scratch_unavailable")?;
        }
        std::fs::write(path, bytes).map_err(|_| "scratch_unavailable")?;
        self.original
            .insert(input.path.clone(), input.sha256.clone());
        self.check()?;
        Ok(())
    }
    fn check(&self) -> Result<()> {
        let mut count = 0;
        let mut bytes = 0;
        scan(
            self.directory.path(),
            self.directory.path(),
            &mut count,
            &mut bytes,
            0,
        )?;
        Ok(())
    }
    fn files(&self) -> Result<Vec<OutputFile>> {
        self.check()?;
        let root = self.directory.path().join("files");
        for original in self.original.keys() {
            if !root.join(original).is_file() {
                return Err("execution_deletions_unsupported");
            }
        }
        let mut paths = Vec::new();
        collect(&root, &root, &mut paths, 0)?;
        let mut outputs = Vec::new();
        for path in paths {
            let bytes = std::fs::read(root.join(&path)).map_err(|_| "invalid_execution_output")?;
            let sha256 = hash(&bytes);
            if self.original.get(&path) == Some(&sha256) {
                continue;
            }
            if outputs.len() >= 20 || bytes.len() > FILE_LIMIT {
                return Err("execution_output_limit");
            }
            outputs.push(OutputFile {
                path,
                bytes,
                sha256,
            });
        }
        Ok(outputs)
    }
}
fn scan(root: &Path, path: &Path, count: &mut usize, bytes: &mut u64, depth: usize) -> Result<()> {
    if depth > 32 {
        return Err("execution_output_limit");
    }
    for entry in std::fs::read_dir(path).map_err(|_| "scratch_unavailable")? {
        let entry = entry.map_err(|_| "scratch_unavailable")?;
        let meta = std::fs::symlink_metadata(entry.path()).map_err(|_| "scratch_unavailable")?;
        *count += 1;
        if *count > 2000 || meta.file_type().is_symlink() {
            return Err("invalid_execution_output");
        }
        if meta.is_dir() {
            scan(root, &entry.path(), count, bytes, depth + 1)?;
        } else if meta.is_file() {
            *bytes = bytes.saturating_add(meta.len());
            if *bytes > TOTAL_LIMIT || meta.len() > FILE_LIMIT as u64 {
                return Err("execution_output_limit");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.nlink() > 1 {
                    return Err("invalid_execution_output");
                }
            }
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileTypeExt;
                // Headless Office uses private runtime IPC while it is active.
                // Sockets are never artifacts and stay outside exported files.
                if meta.file_type().is_socket() && !entry.path().starts_with(root.join("files")) {
                    continue;
                }
            }
            return Err("invalid_execution_output");
        }
    }
    Ok(())
}
fn collect(root: &Path, path: &Path, out: &mut Vec<String>, depth: usize) -> Result<()> {
    if depth > 32 {
        return Err("execution_output_limit");
    }
    for entry in std::fs::read_dir(path).map_err(|_| "invalid_execution_output")? {
        let entry = entry.map_err(|_| "invalid_execution_output")?;
        let meta =
            std::fs::symlink_metadata(entry.path()).map_err(|_| "invalid_execution_output")?;
        if meta.is_dir() {
            collect(root, &entry.path(), out, depth + 1)?;
        } else if meta.is_file() {
            let name = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "invalid_execution_path")?
                .to_str()
                .ok_or("invalid_execution_path")?
                .replace('\\', "/");
            relative(&name)?;
            out.push(name);
        } else {
            return Err("invalid_execution_output");
        }
    }
    out.sort();
    Ok(())
}
struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}
impl Captured {
    fn text(&self, limit: usize) -> String {
        String::from_utf8_lossy(&self.bytes[..self.bytes.len().min(limit)]).into_owned()
    }
}
async fn read_bounded<R: AsyncRead + Unpin>(mut reader: R, limit: usize) -> Result<Captured> {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    loop {
        let n = reader
            .read(&mut buffer)
            .await
            .map_err(|_| "execution_pipe_failed")?;
        if n == 0 {
            return Ok(Captured {
                bytes: output,
                truncated,
            });
        }
        let keep = n.min(limit.saturating_sub(output.len()));
        truncated |= keep < n;
        output.extend_from_slice(&buffer[..keep]);
        // Keep draining pipes after the capture limit. Verbose output must not
        // deadlock or kill an otherwise successful document operation.
    }
}
impl Sandbox {
    pub async fn discover() -> Option<Self> {
        if !cfg!(target_os = "linux") {
            return None;
        }
        let runtime = std::fs::canonicalize(
            std::env::var("WORK_CLOUD_RUNTIME_PATH")
                .unwrap_or_else(|_| "/opt/lori-work-runtime".into()),
        )
        .ok()?;
        if !runtime.join("worker.py").is_file() || !runtime.join("document_helpers.py").is_file() {
            return None;
        }
        let python = if runtime.join("python/bin/python3").is_file() {
            runtime.join("python/bin/python3")
        } else {
            PathBuf::from("/usr/bin/python3")
        };
        if Path::new("/usr/local/bin/lori-work-sandbox").is_file() {
            let sandbox = Self {
                runtime: runtime.clone(),
                python: python.clone(),
                backend: Backend::Helper,
                execution_slot: tokio::sync::Mutex::new(()),
            };
            match sandbox.probe().await {
                Ok(()) => return Some(sandbox),
                Err(code) => eprintln!("cloud_sandbox_probe_failed backend=helper code={code}"),
            }
        }
        let sandbox = Self {
            runtime,
            python,
            backend: Backend::Bubblewrap,
            execution_slot: tokio::sync::Mutex::new(()),
        };
        match sandbox.probe().await {
            Ok(()) => Some(sandbox),
            Err(code) => {
                eprintln!("cloud_sandbox_probe_failed backend=bubblewrap code={code}");
                None
            }
        }
    }
    fn command(
        &self,
        scratch: &Scratch,
        args: &[String],
        timeout: u64,
    ) -> Result<tokio::process::Command> {
        if !cfg!(target_os = "linux") {
            return Err("sandbox_unavailable");
        }
        let mut command = tokio::process::Command::new(match self.backend {
            Backend::Bubblewrap => "/usr/bin/bwrap",
            Backend::Helper => "/usr/local/bin/lori-work-sandbox",
        });
        command
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        match self.backend {
            Backend::Bubblewrap => {
                command.args([
                    "--die-with-parent",
                    "--new-session",
                    "--unshare-all",
                    "--unshare-user",
                    "--disable-userns",
                    "--as-pid-1",
                    "--cap-drop",
                    "ALL",
                    "--clearenv",
                    "--setenv",
                    "PATH",
                    "/opt/lori-work-runtime/python/bin:/usr/local/bin:/usr/bin:/bin",
                    "--setenv",
                    "HOME",
                    "/tmp",
                    "--setenv",
                    "TMPDIR",
                    "/tmp",
                    "--setenv",
                    "OSL_SOCKET_PATH",
                    "/work",
                    "--setenv",
                    "PYTHONDONTWRITEBYTECODE",
                    "1",
                    "--setenv",
                    "PYTHONNOUSERSITE",
                    "1",
                ]);
                for path in ["/usr", "/bin", "/lib", "/lib64"] {
                    if Path::new(path).exists() {
                        command.args(["--ro-bind", path, path]);
                    }
                }
                command
                    .arg("--ro-bind")
                    .arg(&self.runtime)
                    .arg("/opt/lori-work-runtime");
                command
                    .args([
                        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind",
                    ])
                    .arg(scratch.directory.path())
                    .args(["/work", "--chdir", "/work/files", "--"])
                    .arg(if self.python.starts_with(&self.runtime) {
                        PathBuf::from("/opt/lori-work-runtime")
                            .join(self.python.strip_prefix(&self.runtime).unwrap())
                    } else {
                        self.python.clone()
                    })
                    .args(args);
            }
            Backend::Helper => {
                command
                    .env(
                        "PATH",
                        format!(
                            "{}/python/bin:/usr/local/bin:/usr/bin:/bin",
                            self.runtime.display()
                        ),
                    )
                    .env("HOME", scratch.directory.path().join("tmp"))
                    .env("TMPDIR", scratch.directory.path().join("tmp"))
                    .env("PYTHONDONTWRITEBYTECODE", "1")
                    .env("PYTHONNOUSERSITE", "1")
                    .current_dir(scratch.directory.path().join("files"))
                    .arg("--workspace")
                    .arg(scratch.directory.path())
                    .arg("--runtime")
                    .arg(&self.runtime)
                    .arg("--")
                    .arg(&self.python)
                    .args(args);
            }
        }
        #[cfg(unix)]
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                for (kind, value) in [
                    (libc::RLIMIT_AS, 2u64 * 1024 * 1024 * 1024),
                    (libc::RLIMIT_FSIZE, FILE_LIMIT as u64),
                    (libc::RLIMIT_NOFILE, 64),
                    (libc::RLIMIT_NPROC, 64),
                    (libc::RLIMIT_CPU, timeout + 2),
                    (libc::RLIMIT_CORE, 0),
                ] {
                    let bound = libc::rlimit {
                        rlim_cur: value as libc::rlim_t,
                        rlim_max: value as libc::rlim_t,
                    };
                    if libc::setrlimit(kind, &bound) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        Ok(command)
    }
    async fn launch(
        &self,
        scratch: &Scratch,
        args: &[String],
        timeout: Duration,
    ) -> Result<(i32, Captured, Captured)> {
        let mut command = self.command(scratch, args, timeout.as_secs().max(1))?;
        let mut child = command.spawn().map_err(|_| "sandbox_unavailable")?;
        #[cfg(unix)]
        let group = ProcessGroup {
            id: child.id().ok_or("execution_failed")? as i32,
            active: std::sync::atomic::AtomicBool::new(true),
        };
        let stdout = child.stdout.take().ok_or("execution_pipe_failed")?;
        let stderr = child.stderr.take().ok_or("execution_pipe_failed")?;
        let monitor = async {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                scratch.check()?;
            }
        };
        tokio::pin!(monitor);
        let result = tokio::select! {
            result=tokio::time::timeout(timeout,async{let (status,stdout,stderr)=tokio::try_join!(async{let status=child.wait().await.map_err(|_|"execution_failed")?;#[cfg(unix)]group.kill();Ok(status)},read_bounded(stdout,OUTPUT_LIMIT),read_bounded(stderr,128*1024))?;Ok((status.code().unwrap_or(128),stdout,stderr))})=>result.map_err(|_|"execution_timeout")?,
            result=&mut monitor=>result,
        };
        if result.is_err() {
            #[cfg(unix)]
            group.kill();
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        result
    }
    async fn probe(&self) -> Result<()> {
        let scratch = Scratch::new()?;
        let outside = tempfile::tempdir().map_err(|_| "sandbox_unavailable")?;
        let canary = outside.path().join("private-secret");
        std::fs::write(&canary, b"private canary").map_err(|_| "sandbox_unavailable")?;
        let namespace_check = if matches!(self.backend, Backend::Bubblewrap) {
            let net = std::fs::read_link("/proc/self/ns/net").map_err(|_| "sandbox_unavailable")?;
            let pid = std::fs::read_link("/proc/self/ns/pid").map_err(|_| "sandbox_unavailable")?;
            format!("assert os.readlink('/proc/self/ns/net')!={}; assert os.readlink('/proc/self/ns/pid')!={}\n",json!(net.to_string_lossy()),json!(pid.to_string_lossy()))
        } else {
            String::from("for escape in (os.setsid,lambda:os.setpgid(0,0)):\n try: escape(); raise AssertionError('process group escaped')\n except OSError: pass\n")
        };
        let mut denied_paths = vec![
            canary.to_string_lossy().to_string(),
            std::env::var("WORK_CLOUD_WORKER_SECRET_FILE")
                .unwrap_or_else(|_| "/run/lori-work-cloud/worker-secret".into()),
            "/run/lori-app/provider-gateway-secret".into(),
        ];
        // Landlock mediates file access, not stat metadata. Open/read is the
        // actual confidentiality check. A private PID namespace has its own
        // environment, whereas helper mode must deny the outer init's bytes.
        if matches!(self.backend, Backend::Helper) {
            denied_paths.push("/proc/1/environ".into());
        }
        let script=format!("import os,socket,subprocess; import docx,openpyxl,pptx,pypdfium2,PIL,reportlab; assert all(not any(s in k.upper() for s in ('SECRET','TOKEN','API_KEY','DATABASE')) for k in os.environ)\n{}for path in {}:\n try:\n  with open(path,'rb') as source: source.read(1)\n  raise AssertionError('outside read allowed')\n except (PermissionError,FileNotFoundError): pass\ntry:\n with open({},'wb') as target: target.write(b'changed')\n raise AssertionError('outside write allowed')\nexcept (PermissionError,FileNotFoundError): pass\ntry:\n s=socket.socket(); s.settimeout(0.2); s.connect(('1.1.1.1',443)); raise AssertionError('network access')\nexcept OSError: pass\nprint('isolated')",namespace_check,json!(denied_paths),json!(canary.to_string_lossy()));
        let (exit, stdout, stderr) = self
            .launch(
                &scratch,
                &["-I".into(), "-c".into(), script],
                Duration::from_secs(10),
            )
            .await?;
        if std::fs::read(&canary).map_err(|_| "sandbox_qualification_failed")? != b"private canary"
        {
            return Err("sandbox_qualification_failed");
        }
        if exit != 0 || stdout.bytes != b"isolated\n" || stdout.truncated {
            eprintln!(
                "cloud_sandbox_probe_rejected exit={exit} stdout_bytes={} stderr_bytes={}",
                stdout.bytes.len(),
                stderr.bytes.len()
            );
            return Err("sandbox_qualification_failed");
        }
        // Main-process exit must clean up descendants before their inherited
        // pipes close, for both PID namespaces and the confined process group.
        let script="import subprocess,sys; subprocess.Popen([sys.executable,'-I','-c',\"import time; time.sleep(600)\"]); print('cleanup')";
        let (exit, _, _) = self
            .launch(
                &scratch,
                &["-I".into(), "-c".into(), script.into()],
                Duration::from_secs(3),
            )
            .await?;
        if exit != 0 {
            return Err("sandbox_cleanup_failed");
        }
        // Imports alone do not qualify Office, PDF rendering or formula caches.
        // Exercise the unchanged document broker with deterministic private
        // inputs before advertising any isolated document operation.
        tokio::time::timeout(Duration::from_secs(30), self.document_preflight())
            .await
            .map_err(|_| "document_qualification_timeout")??;
        Ok(())
    }
    async fn document_preflight(&self) -> Result<()> {
        let mut scratch = Scratch::new()?;
        let workspace = match self.backend {
            Backend::Bubblewrap => PathBuf::from("/work/files"),
            Backend::Helper => scratch.directory.path().join("files"),
        };
        let create = format!(
            "from pathlib import Path; from docx import Document; from openpyxl import Workbook; root=Path({}); document=Document(); document.add_paragraph('LORI RUNTIME CHECK 24680'); document.save(root/'qualification.docx'); book=Workbook(); sheet=book.active; sheet['A1']=2; sheet['A2']=3; sheet['A3']='=SUM(A1:A2)'; book.save(root/'qualification.xlsx'); print('prepared')",
            json!(workspace.to_string_lossy())
        );
        let (exit, stdout, _) = self
            .launch(
                &scratch,
                &["-I".into(), "-c".into(), create],
                Duration::from_secs(10),
            )
            .await?;
        if exit != 0 || stdout.bytes != b"prepared\n" || stdout.truncated {
            return Err("document_creation_qualification_failed");
        }
        for path in ["qualification.docx", "qualification.xlsx"] {
            let bytes = std::fs::read(scratch.directory.path().join("files").join(path))
                .map_err(|_| "document_creation_qualification_failed")?;
            scratch.original.insert(path.into(), hash(&bytes));
        }
        let operation = |name: &str, arguments: Value| Execution {
            kind: "document".into(),
            operation: name.into(),
            arguments,
            inputs: vec![],
            outputs: vec![],
        };
        let converted = self
            .execute(
                &operation("convert_document", json!({"path":"qualification.docx","outputPath":"qualification.pdf","timeoutSeconds":20})),
                &scratch,
            )
            .await.map_err(|_| "document_conversion_qualification_failed")?;
        let pdf = std::fs::read(scratch.directory.path().join("files/qualification.pdf"))
            .map_err(|_| "document_conversion_qualification_failed")?;
        if converted.failed || !pdf.starts_with(b"%PDF-") {
            return Err("document_conversion_qualification_failed");
        }
        let read = self
            .execute(
                &operation(
                    "read_document",
                    json!({"path":"qualification.pdf","startPage":1,"limit":1,"timeoutSeconds":20}),
                ),
                &scratch,
            )
            .await
            .map_err(|_| "document_read_qualification_failed")?;
        if read.failed
            || !read.output["text"]
                .as_str()
                .is_some_and(|text| text.contains("LORI RUNTIME CHECK 24680"))
        {
            return Err("document_read_qualification_failed");
        }
        let rendered = self
            .execute(
                &operation("render_document", json!({"path":"qualification.pdf","outputDirectory":"qualification-pages","startPage":1,"limit":1,"timeoutSeconds":20})),
                &scratch,
            )
            .await.map_err(|_| "document_render_qualification_failed")?;
        if rendered.failed
            || !rendered.files.iter().any(|file| {
                file.path.starts_with("qualification-pages/")
                    && file.bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            })
        {
            return Err("document_render_qualification_failed");
        }
        let calculated = self
            .execute(
                &operation("recalculate_spreadsheet", json!({"path":"qualification.xlsx","outputPath":"qualification-calculated.xlsx","timeoutSeconds":20})),
                &scratch,
            )
            .await.map_err(|_| "spreadsheet_qualification_failed")?;
        if calculated.failed {
            return Err("spreadsheet_qualification_failed");
        }
        let verify = format!(
            "from pathlib import Path; from openpyxl import load_workbook; root=Path({}); cached=load_workbook(root/'qualification-calculated.xlsx',data_only=True); formulas=load_workbook(root/'qualification-calculated.xlsx',data_only=False); assert cached.active['A3'].value==5; assert formulas.active['A3'].value=='=SUM(A1:A2)'; cached.close(); formulas.close(); print('calculated')",
            json!(workspace.to_string_lossy())
        );
        let (exit, stdout, _) = self
            .launch(
                &scratch,
                &["-I".into(), "-c".into(), verify],
                Duration::from_secs(10),
            )
            .await?;
        if exit != 0 || stdout.bytes != b"calculated\n" || stdout.truncated {
            return Err("spreadsheet_qualification_failed");
        }
        Ok(())
    }
    pub async fn execute(&self, execution: &Execution, scratch: &Scratch) -> Result<Outcome> {
        let _slot = self.execution_slot.lock().await;
        let document = matches!(
            execution.operation.as_str(),
            "read_document"
                | "inspect_document"
                | "validate_document"
                | "convert_document"
                | "render_document"
                | "preview_document"
                | "recalculate_spreadsheet"
                | "view_image"
        );
        if !(execution.kind == "python" && execution.operation == "run_command"
            || execution.kind == "document" && document)
        {
            return Err("unsupported_execution_operation");
        }
        for path in &execution.outputs {
            relative(path)?;
        }
        if let Some(cwd) = execution.arguments["cwd"]
            .as_str()
            .filter(|p| !p.is_empty() && *p != ".")
        {
            let directory = scratch.directory.path().join("files").join(relative(cwd)?);
            std::fs::create_dir_all(directory).map_err(|_| "invalid_execution_cwd")?;
        }
        let workspace = match self.backend {
            Backend::Bubblewrap => PathBuf::from("/work/files"),
            Backend::Helper => scratch.directory.path().join("files"),
        };
        let request = json!({"tool":execution.operation,"arguments":execution.arguments,"workspace":workspace});
        std::fs::write(
            scratch.directory.path().join(".lori-request.json"),
            serde_json::to_vec(&request).map_err(|_| "invalid_execution_request")?,
        )
        .map_err(|_| "scratch_unavailable")?;
        let seconds = execution.arguments["timeoutSeconds"]
            .as_u64()
            .unwrap_or(120)
            .clamp(1, 600);
        let (exit, stdout, stderr) = self
            .launch(
                scratch,
                &[
                    "-I".into(),
                    match self.backend {
                        Backend::Bubblewrap => PathBuf::from("/opt/lori-work-runtime/worker.py"),
                        Backend::Helper => self.runtime.join("worker.py"),
                    }
                    .to_string_lossy()
                    .into(),
                    "--request".into(),
                    match self.backend {
                        Backend::Bubblewrap => PathBuf::from("/work/.lori-request.json"),
                        Backend::Helper => scratch.directory.path().join(".lori-request.json"),
                    }
                    .to_string_lossy()
                    .into(),
                ],
                Duration::from_secs(seconds + 5),
            )
            .await?;
        let output = if document && exit == 0 {
            if stdout.truncated {
                return Err("execution_output_limit");
            }
            serde_json::from_slice(&stdout.bytes).map_err(|_| "invalid_document_result")?
        } else {
            // Even worst-case JSON escaping stays below the API's 1 MiB
            // decoded-result limit. Disclose clipping instead of false failure.
            json!({"exitCode":exit,"stdout":stdout.text(96*1024),"stderr":stderr.text(32*1024),
                "stdoutTruncated":stdout.truncated || stdout.bytes.len()>96*1024,
                "stderrTruncated":stderr.truncated || stderr.bytes.len()>32*1024})
        };
        let files = if exit == 0
            && !matches!(
                execution.operation.as_str(),
                "read_document" | "inspect_document" | "validate_document" | "view_image"
            ) {
            scratch.files()?
        } else {
            vec![]
        };
        Ok(Outcome {
            output,
            failed: exit != 0,
            files,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn verbose_command_output_is_drained_but_capture_is_bounded() {
        let bytes = vec![b'x'; 200_000];
        let output = read_bounded(bytes.as_slice(), 1024).await.unwrap();
        assert_eq!(output.bytes.len(), 1024);
        assert!(output.truncated);
        let exact = read_bounded(b"abc".as_slice(), 3).await.unwrap();
        assert_eq!(exact.bytes, b"abc");
        assert!(!exact.truncated);
    }
    #[test]
    fn command_result_stays_under_api_limit_even_with_escaped_control_output() {
        let captured = Captured {
            bytes: vec![0; OUTPUT_LIMIT],
            truncated: true,
        };
        let result =
            json!({"stdout":captured.text(96*1024),"stderr":captured.text(32*1024),"exitCode":0});
        assert!(serde_json::to_vec(&result).unwrap().len() < 1024 * 1024);
    }
    #[test]
    fn artifact_paths_match_virtual_workspace_limits() {
        assert!(relative("notes/plan:final.txt").is_ok());
        assert!(relative(&"é".repeat(240)).is_ok());
        for path in ["a\nb", "a\u{7f}", ".lori-internal/output"] {
            assert!(relative(path).is_err());
        }
        assert!(relative(&"😀".repeat(121)).is_err());
    }
    #[test]
    fn staged_inputs_verify_hash_and_cannot_escape() {
        let mut scratch = Scratch::new().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(scratch.directory.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0,
                "execution scratch must be private before staging any input"
            );
        }
        let bytes = b"data";
        let mut input = Input {
            path: "a/data.txt".into(),
            file_id: "id".into(),
            sha256: hash(bytes),
        };
        scratch.stage(&input, bytes).unwrap();
        assert!(scratch.stage(&input, bytes).is_err());
        for path in [
            "../secrets",
            "/etc/passwd",
            "a/../../b",
            ".lori-request.json",
            "a\\b",
            "a//b",
        ] {
            input.path = path.into();
            assert!(scratch.stage(&input, bytes).is_err());
        }
        input.path = "other.txt".into();
        assert!(scratch.stage(&input, b"changed").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn sandbox_output_rejects_symlinks_and_hardlinks() {
        let scratch = Scratch::new().unwrap();
        std::os::unix::fs::symlink("/etc/passwd", scratch.directory.path().join("files/link"))
            .unwrap();
        assert!(scratch.files().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn private_runtime_ipc_is_monitored_but_never_exported() {
        let scratch = Scratch::new().unwrap();
        let _private =
            std::os::unix::net::UnixListener::bind(scratch.directory.path().join("office.sock"))
                .unwrap();
        assert!(scratch.check().is_ok());
        assert!(scratch.files().unwrap().is_empty());
        let _artifact =
            std::os::unix::net::UnixListener::bind(scratch.directory.path().join("files/socket"))
                .unwrap();
        assert!(scratch.files().is_err());
    }
    #[tokio::test]
    #[ignore = "requires a qualified Linux runtime and isolation helper"]
    async fn actual_linux_sandbox_qualification() {
        assert!(
            Sandbox::discover().await.is_some(),
            "Linux sandbox, dependency, network, secret and process-cleanup qualification failed"
        );
    }
}
