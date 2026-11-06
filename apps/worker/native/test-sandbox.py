"""Defensive regressions for the shipped helper under the worker container policy."""
import ctypes
import errno
import fcntl
import os
import pathlib
import platform
import signal
import socket
import subprocess
import sys
import tempfile


def denied(operation):
    try:
        operation()
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES), error
    else:
        raise AssertionError("sandbox allowed a forbidden operation")


def inside(canary, inherited_fd):
    pathlib.Path("output.txt").write_text("created")
    assert pathlib.Path("output.txt").read_text() == "created"
    subprocess.run(["python3", "-c", "import docx, openpyxl, reportlab"], check=True)
    assert set(os.environ) <= {
        "PATH", "HOME", "TMPDIR", "OSL_SOCKET_PATH", "TZ", "PYTHONDONTWRITEBYTECODE", "LC_CTYPE"
    }
    for path in (canary, "/proc/1/environ", "/etc/shadow"):
        denied(lambda path=path: pathlib.Path(path).read_bytes())
    denied(lambda: pathlib.Path(canary).write_text("changed"))
    try:
        os.fstat(int(inherited_fd))
    except OSError as error:
        assert error.errno == errno.EBADF
    else:
        raise AssertionError("inherited descriptor was not closed")
    for domain in (socket.AF_INET, socket.AF_INET6):
        denied(lambda domain=domain: socket.socket(domain))
    # Office needs Unix IPC. It is confined to this dedicated worker container's
    # network namespace; no other jobs/services or host sockets may share it.
    with socket.socket(socket.AF_UNIX) as local_ipc:
        address = str(pathlib.Path.cwd() / "office-test.sock")
        local_ipc.bind(address)
        local_ipc.listen(1)
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(address)
            connection, _ = local_ipc.accept()
            with connection:
                client.sendall(b"private IPC")
                assert connection.recv(32) == b"private IPC"
    with socket.socket(socket.AF_UNIX) as outside_ipc:
        denied(lambda: outside_ipc.bind(str(pathlib.Path(canary).parent / "outside.sock")))
    for code in ("os.setsid()", "os.setpgid(0,0)", "os.kill(1,0)"):
        child = subprocess.run(
            [sys.executable, "-c", "import os;" + code], capture_output=True
        )
        assert child.returncode != 0, code
    with socket.socketpair()[0] as local:
        denied(lambda: fcntl.fcntl(local, fcntl.F_SETOWN, 1))
    denied(lambda: os.setpriority(os.PRIO_PROCESS, os.getppid(), 0))
    denied(lambda: os.symlink("/etc/shadow", "outside-link"))
    libc = ctypes.CDLL(None, use_errno=True)
    # Shared IPC and parent reparenting must be denied even without network.
    for name, args in (("shmget", (0, 4096, 0o1600)),
                       ("msgget", (0, 0o1600)), ("semget", (0, 1, 0o1600))):
        assert getattr(libc, name)(*args) == -1
        assert ctypes.get_errno() == errno.EPERM
    clone_syscall = {"x86_64": 56, "aarch64": 220}[platform.machine()]
    libc.syscall.restype = ctypes.c_long
    assert libc.syscall(clone_syscall, 0x8000 | signal.SIGCHLD,
                        None, None, None, 0) == -1
    assert ctypes.get_errno() == errno.EPERM
    print("sandbox isolation regressions passed", flush=True)


def outside():
    with tempfile.TemporaryDirectory(prefix="lori-sandbox-test-") as root:
        workspace = pathlib.Path(root, "workspace")
        workspace.mkdir(mode=0o700)
        canary = pathlib.Path(root, "private-canary")
        canary.write_text("isolated")
        with canary.open("rb") as descriptor:
            subprocess.run([
                "/usr/local/bin/lori-work-sandbox", "--workspace", str(workspace),
                "--runtime", "/opt/lori-work-runtime", "--", sys.executable,
                __file__, "--inside", str(canary), str(descriptor.fileno())
            ], pass_fds=(descriptor.fileno(),), check=True, timeout=20)
        assert canary.read_text() == "isolated"


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--inside":
        inside(sys.argv[2], sys.argv[3])
    else:
        outside()
