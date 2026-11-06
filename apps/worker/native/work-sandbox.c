/* Unprivileged, fail-closed Linux execution adapter for container deployments.
 * Landlock confines files; seccomp denies IP networking and process escapes.
 * Unix IPC stays inside the dedicated one-job worker container network namespace
 * for headless Office. No host sockets or other local services may be mounted.
 * The supervisor creates a dedicated process group and owns its deadline/cleanup.
 * This helper never receives or reads worker/provider/database credentials.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <seccomp.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* The clone argument layout and ioctl argument filter below are qualified only
 * on the little-endian architectures published by the worker release. */
#if !defined(__x86_64__) && !defined(__aarch64__)
#error Unsupported Work sandbox architecture
#endif
#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error Unsupported Work sandbox byte order
#endif

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif

struct work_ruleset { uint64_t fs, net, scoped; };
static void fail(const char *operation) {
  /* Never echo command text, file contents, environment, or credentials. */
  fprintf(stderr, "Work sandbox unavailable: %s (%d)\n", operation, errno);
  exit(125);
}
static void limit(int kind, rlim_t value) {
  struct rlimit inherited;
  if (getrlimit(kind, &inherited)) fail("inherited resource limit");
  if (inherited.rlim_max != RLIM_INFINITY && value > inherited.rlim_max) value = inherited.rlim_max;
  struct rlimit bound = {value, value};
  if (setrlimit(kind, &bound)) fail("resource limit");
}
static void path_rule(int ruleset, const char *path, uint64_t access, int optional) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) { if (optional && errno == ENOENT) return; fail("runtime path"); }
  struct stat info;
  if (fstat(fd, &info)) fail("runtime path inspection");
  if (!S_ISDIR(info.st_mode)) access &= LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV;
  struct landlock_path_beneath_attr rule = {.allowed_access = access, .parent_fd = fd};
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail("filesystem rule");
  close(fd);
}
static void deny(scmp_filter_ctx context, const char *name) {
  int number = seccomp_syscall_resolve_name(name);
  if (number != __NR_SCMP_ERROR && seccomp_rule_add(context, SCMP_ACT_ERRNO(EPERM), number, 0)) fail("syscall rule");
}

int main(int argc, char **argv) {
  if (argc < 7 || strcmp(argv[1], "--workspace") || strcmp(argv[3], "--runtime") || strcmp(argv[5], "--")) {
    errno = EINVAL; fail("arguments");
  }
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 4) { errno = ENOTSUP; fail("Landlock ABI 4 required"); }
  char *workspace = realpath(argv[2], NULL), *runtime = realpath(argv[4], NULL);
  if (!workspace || !runtime || !strcmp(workspace, "/") || !strcmp(runtime, "/") || !strcmp(workspace, runtime)) { errno = EINVAL; fail("workspace"); }
  struct stat info;
  if (lstat(workspace, &info) || !S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 0077)) { errno = EACCES; fail("private workspace"); }
  /* Treat all supported filesystem rights as denied unless explicitly granted.
   * No char/block device creation, symlinks, or host path access is granted.
   */
  const uint64_t read = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
  const uint64_t write = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct work_ruleset policy = {.fs = (1ULL << 15) - 1, .net = 3, .scoped = abi >= 6 ? 3 : 0};
  if (abi >= 5) policy.fs |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  int ruleset = syscall(SYS_landlock_create_ruleset, &policy, abi >= 6 ? sizeof(policy) : 16, 0);
  if (ruleset < 0) fail("filesystem policy");
  path_rule(ruleset, "/usr", read, 0);
  path_rule(ruleset, "/bin", read, 0);
  path_rule(ruleset, "/lib", read, 0);
  path_rule(ruleset, "/lib64", read, 1);
  path_rule(ruleset, runtime, read, 0);
  path_rule(ruleset, workspace, (read & ~LANDLOCK_ACCESS_FS_EXECUTE) | write, 0);
  path_rule(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
  path_rule(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 0);
  path_rule(ruleset, "/dev/random", LANDLOCK_ACCESS_FS_READ_FILE, 1);
  path_rule(ruleset, "/etc/fonts", read & ~LANDLOCK_ACCESS_FS_EXECUTE, 1);
  path_rule(ruleset, "/etc/mime.types", LANDLOCK_ACCESS_FS_READ_FILE, 1);
  /* Debian packages keep public Office configuration behind /usr symlinks. */
  path_rule(ruleset, "/etc/libreoffice", read & ~LANDLOCK_ACCESS_FS_EXECUTE, 1);
  path_rule(ruleset, "/var/lib/libreoffice/share/prereg/bundled", read & ~LANDLOCK_ACCESS_FS_EXECUTE, 1);
  path_rule(ruleset, "/var/spool/libreoffice/uno_packages/cache", read & ~LANDLOCK_ACCESS_FS_EXECUTE, 1);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || syscall(SYS_landlock_restrict_self, ruleset, 0)) fail("filesystem confinement");
  close(ruleset);

  scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ALLOW);
  if (!filter || seccomp_attr_set(filter, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS)) fail("syscall policy");
  const char *blocked[] = {
    "socketcall",
    "kill", "tkill", "tgkill", "pidfd_send_signal", "rt_sigqueueinfo", "rt_tgsigqueueinfo",
    "setsid", "setpgid", "ptrace", "process_vm_readv", "process_vm_writev", "pidfd_getfd",
    "shmget", "shmat", "shmdt", "shmctl", "msgget", "msgsnd", "msgrcv", "msgctl", "semget", "semop", "semtimedop", "semctl", "ipc",
    "setpriority", "nice", "sched_setparam", "sched_setscheduler", "sched_setattr", "sched_setaffinity", "ioprio_set",
    "unshare", "setns", "mount", "umount", "umount2", "pivot_root", "chroot", "move_mount", "open_tree", "fsopen", "fsmount", "fspick", "mount_setattr",
    "bpf", "perf_event_open", "keyctl", "add_key", "request_key", "userfaultfd",
    "io_uring_setup", "io_uring_enter", "io_uring_register", "kcmp", "process_madvise", "process_mrelease", "kexec_load", "kexec_file_load",
    "init_module", "finit_module", "delete_module", "reboot", "swapon", "swapoff", "open_by_handle_at"
  };
  for (size_t i = 0; i < sizeof(blocked) / sizeof(blocked[0]); i++) deny(filter, blocked[i]);
  /* clone3 returns ENOSYS so libc can use its non-namespace clone fallback. */
  int clone3_nr = seccomp_syscall_resolve_name("clone3");
  if (clone3_nr != __NR_SCMP_ERROR && seccomp_rule_add(filter, SCMP_ACT_ERRNO(ENOSYS), clone3_nr, 0)) fail("clone3 rule");
  /* CLONE_PARENT must not reparent sandbox children to the trusted supervisor. */
  const uint64_t namespace_flags = 0x7e028080ULL;
  if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1, SCMP_A0(SCMP_CMP_MASKED_EQ, namespace_flags, namespace_flags))) fail("clone rule");
  /* Block each namespace flag individually, including mixed-flag clones. */
  for (uint64_t bit = 1; bit; bit <<= 1) if (namespace_flags & bit)
    if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1, SCMP_A0(SCMP_CMP_MASKED_EQ, bit, bit))) fail("clone namespace rule");
  if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socketpair), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX))) fail("socketpair rule");
  if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX))) fail("socket domain rule");
  if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(prlimit64), 1, SCMP_A0(SCMP_CMP_NE, 0))) fail("process resource rule");
  for (unsigned int command = 8; command <= 15; command++) if (command == 8 || command == 10 || command == 15)
    if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(fcntl), 1, SCMP_A1(SCMP_CMP_EQ, command))) fail("asynchronous signal rule");
  if (seccomp_load(filter)) fail("syscall confinement");
  seccomp_release(filter);
  /* Python uses FIOCLEX while opening files. Permit only descriptor/terminal
   * metadata ioctls; async signal ownership and all device control stay denied.
   */
  struct sock_filter ioctl_filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 6),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5451, 4, 0), /* FIOCLEX */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5450, 3, 0), /* FIONCLEX */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x541b, 2, 0), /* FIONREAD */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5401, 1, 0), /* TCGETS */
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog ioctl_program = {.len = sizeof(ioctl_filter) / sizeof(ioctl_filter[0]), .filter = ioctl_filter};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &ioctl_program)) fail("ioctl confinement");
  limit(RLIMIT_CORE, 0);
  limit(RLIMIT_AS, 2ULL * 1024 * 1024 * 1024);
  limit(RLIMIT_CPU, 120);
  limit(RLIMIT_FSIZE, 20ULL * 1024 * 1024);
  limit(RLIMIT_NOFILE, 64);
  limit(RLIMIT_NPROC, 64);
  limit(RLIMIT_MEMLOCK, 0);
  /* Keep only pipes/devnull supplied by the trusted supervisor. */
  if (syscall(SYS_close_range, 3U, ~0U, 0)) fail("descriptor isolation");
  char *runtime_path;
  if (asprintf(&runtime_path, "%s/python/bin:/usr/local/bin:/usr/bin:/bin", runtime) < 0) fail("runtime environment");
  if (clearenv() || setenv("PATH", runtime_path, 1) || setenv("HOME", workspace, 1) || setenv("TMPDIR", workspace, 1) || setenv("OSL_SOCKET_PATH", workspace, 1) || setenv("TZ", "UTC", 1) || setenv("PYTHONDONTWRITEBYTECODE", "1", 1)) fail("environment");
  free(runtime_path);
  if (chdir(workspace)) fail("working directory");
  execv(argv[6], &argv[6]);
  fail("runtime launch");
}
