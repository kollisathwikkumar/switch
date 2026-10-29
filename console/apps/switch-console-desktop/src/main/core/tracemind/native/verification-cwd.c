#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dirent.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <signal.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/capability.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#endif

/* fd 3 is the pinned cwd; fd 4 confirms the final command exec; fd 5 optionally
   attaches this trusted process to a preconfigured cgroup v2 before exec. */
static void fail(int code) {
  if (write(4, "E", 1) != 1) {
    /* The parent also rejects a missing marker if this diagnostic pipe is closed. */
  }
  _exit(code);
}

static void set_cloexec(int fd, int enabled) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0) fail(70);
  flags = enabled ? (flags | FD_CLOEXEC) : (flags & ~FD_CLOEXEC);
  if (fcntl(fd, F_SETFD, flags) < 0) fail(70);
}

static void write_handoff_success(void) {
  ssize_t count;
  do {
    count = write(4, "S", 1);
  } while (count < 0 && errno == EINTR);
  if (count != 1) fail(70);
}

static void write_helper_status(int cgroup_attached) {
  const char *status = cgroup_attached
    ? "{ \"tracemind-host-helper-ready\": true, \"tracemind-cgroup-attached\": true }\n"
    : "{ \"tracemind-host-helper-ready\": true, \"tracemind-cgroup-attached\": false }\n";
  size_t length = strlen(status);
  size_t written = 0;
  while (written < length) {
    ssize_t count = write(4, status + written, length - written);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail(70);
    written += (size_t)count;
  }
}

static int write_all(int fd, const void *buffer, size_t length) {
  const char *bytes = (const char *)buffer;
  size_t written = 0;
  while (written < length) {
    ssize_t count = write(fd, bytes + written, length - written);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    written += (size_t)count;
  }
  return 0;
}

static int write_target_frame(char type, const void *payload, uint32_t length) {
  unsigned char header[9] = {
    'T', 'M', 'X', '1', (unsigned char)type,
    (unsigned char)(length >> 24), (unsigned char)(length >> 16),
    (unsigned char)(length >> 8), (unsigned char)length
  };
  if (write_all(STDOUT_FILENO, header, sizeof(header)) < 0) return -1;
  if (length > 0 && write_all(STDOUT_FILENO, payload, length) < 0) return -1;
  return 0;
}

static void encode_u32(unsigned char output[4], uint32_t value) {
  output[0] = (unsigned char)(value >> 24);
  output[1] = (unsigned char)(value >> 16);
  output[2] = (unsigned char)(value >> 8);
  output[3] = (unsigned char)value;
}

static int report_target_failure(int error) {
  unsigned char payload[4];
  encode_u32(payload, (uint32_t)(error > 0 ? error : EIO));
  (void)write_target_frame('F', payload, sizeof(payload));
  return 125;
}

static void close_child_fds_except(int keep_fd) {
#ifdef __linux__
#ifdef SYS_close_range
  int range_result = 0;
  if (keep_fd > 3 && syscall(SYS_close_range, 3U, (unsigned int)keep_fd - 1U, 0U) < 0)
    range_result = -1;
  if (syscall(SYS_close_range, (unsigned int)keep_fd + 1U, UINT_MAX, 0U) < 0)
    range_result = -1;
  if (range_result == 0) return;
#endif
#endif
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 0 || maximum > 65536) maximum = 65536;
  for (long fd = 3; fd < maximum; fd++) if (fd != keep_fd) (void)close((int)fd);
}

static int read_exec_result(int fd, int *child_error) {
  unsigned char *bytes = (unsigned char *)child_error;
  size_t received = 0;
  for (;;) {
    ssize_t count = read(fd, bytes + received, sizeof(*child_error) - received);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return -1;
    if (count == 0) return received == 0 ? 0 : -1;
    received += (size_t)count;
    if (received == sizeof(*child_error)) return 1;
  }
}

/* A Bubblewrap target runs below the namespace init (PID 1). Kill only other
   PIDs visible in that private namespace; host processes are not addressable
   through its /proc. Repeat until no live namespace descendants remain. */
static int terminate_private_namespace_processes(void) {
#ifdef __linux__
  if (getpid() <= 1 || getppid() != 1) return 0;
  DIR *proc = opendir("/proc");
  if (!proc) return -1;
  int found = 0;
  struct dirent *entry;
  while ((entry = readdir(proc)) != NULL) {
    char *end = NULL;
    errno = 0;
    long pid = strtol(entry->d_name, &end, 10);
    if (errno != 0 || end == entry->d_name || *end != '\0' || pid <= 1 || pid == (long)getpid())
      continue;
    if (kill((pid_t)pid, SIGKILL) == 0 || errno == EPERM) found = 1;
    else if (errno != ESRCH) {
      int saved = errno;
      (void)closedir(proc);
      errno = saved;
      return -1;
    }
  }
  if (closedir(proc) < 0) return -1;
  return found;
#else
  return 0;
#endif
}

static int target_wrapper(int argc, char **argv) {
  if (argc < 3 || argv[2][0] != '/') return report_target_failure(EINVAL);
#ifdef __linux__
  struct __user_cap_header_struct capability_header = {
    .version = _LINUX_CAPABILITY_VERSION_3,
    .pid = 0
  };
  struct __user_cap_data_struct capability_data[2] = {{0}};
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) < 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
      syscall(SYS_capset, &capability_header, capability_data) < 0) {
    return report_target_failure(errno);
  }
#endif

  int stdout_pipe[2] = {-1, -1};
  int stderr_pipe[2] = {-1, -1};
  int exec_pipe[2] = {-1, -1};
  if (pipe(stdout_pipe) < 0 || pipe(stderr_pipe) < 0 || pipe(exec_pipe) < 0) {
    int saved = errno;
    if (stdout_pipe[0] >= 0) close(stdout_pipe[0]);
    if (stdout_pipe[1] >= 0) close(stdout_pipe[1]);
    if (stderr_pipe[0] >= 0) close(stderr_pipe[0]);
    if (stderr_pipe[1] >= 0) close(stderr_pipe[1]);
    if (exec_pipe[0] >= 0) close(exec_pipe[0]);
    if (exec_pipe[1] >= 0) close(exec_pipe[1]);
    return report_target_failure(saved);
  }
  int flags = fcntl(exec_pipe[1], F_GETFD);
  if (flags < 0 || fcntl(exec_pipe[1], F_SETFD, flags | FD_CLOEXEC) < 0) {
    int saved = errno;
    close(stdout_pipe[0]); close(stdout_pipe[1]);
    close(stderr_pipe[0]); close(stderr_pipe[1]);
    close(exec_pipe[0]); close(exec_pipe[1]);
    return report_target_failure(saved);
  }

  pid_t target = fork();
  if (target < 0) {
    int saved = errno;
    close(stdout_pipe[0]); close(stdout_pipe[1]);
    close(stderr_pipe[0]); close(stderr_pipe[1]);
    close(exec_pipe[0]); close(exec_pipe[1]);
    return report_target_failure(saved);
  }
  if (target == 0) {
    close(stdout_pipe[0]);
    close(stderr_pipe[0]);
    close(exec_pipe[0]);
    if (dup2(stdout_pipe[1], STDOUT_FILENO) < 0 ||
        dup2(stderr_pipe[1], STDERR_FILENO) < 0) {
      int saved = errno;
      (void)write_all(exec_pipe[1], &saved, sizeof(saved));
      _exit(126);
    }
    close_child_fds_except(exec_pipe[1]);
    execv(argv[2], &argv[2]);
    int saved = errno;
    (void)write_all(exec_pipe[1], &saved, sizeof(saved));
    _exit(saved == ENOENT ? 127 : 126);
  }

  close(stdout_pipe[1]);
  close(stderr_pipe[1]);
  close(exec_pipe[1]);
  int exec_error = 0;
  int exec_result = read_exec_result(exec_pipe[0], &exec_error);
  close(exec_pipe[0]);
  if (exec_result != 0) {
    (void)kill(target, SIGKILL);
    while (waitpid(target, NULL, 0) < 0 && errno == EINTR) {}
    close(stdout_pipe[0]); close(stderr_pipe[0]);
    return report_target_failure(exec_result < 0 ? errno : exec_error);
  }
  if (write_target_frame('H', NULL, 0) < 0) {
    (void)kill(target, SIGKILL);
    while (waitpid(target, NULL, 0) < 0 && errno == EINTR) {}
    close(stdout_pipe[0]); close(stderr_pipe[0]);
    return 125;
  }

  int output_fds[2] = {stdout_pipe[0], stderr_pipe[0]};
  char output[16384];
  int open_count = 2;
  int target_exited = 0;
  int wait_status = 0;
  while (open_count > 0 || !target_exited) {
    struct pollfd descriptors[2];
    nfds_t descriptor_count = 0;
    for (int i = 0; i < 2; i++) {
      if (output_fds[i] >= 0) {
        descriptors[descriptor_count].fd = output_fds[i];
        descriptors[descriptor_count].events = POLLIN | POLLHUP | POLLERR;
        descriptors[descriptor_count].revents = 0;
        descriptor_count++;
      }
    }
    int ready;
    do { ready = poll(descriptors, descriptor_count, 50); } while (ready < 0 && errno == EINTR);
    if (ready < 0) {
      int saved = errno;
      (void)kill(target, SIGKILL);
      while (waitpid(target, NULL, 0) < 0 && errno == EINTR) {}
      close(output_fds[0]); close(output_fds[1]);
      return report_target_failure(saved);
    }
    for (nfds_t i = 0; i < descriptor_count; i++) {
      if (descriptors[i].revents == 0) continue;
      int fd = descriptors[i].fd;
      ssize_t count;
      do { count = read(fd, output, sizeof(output)); } while (count < 0 && errno == EINTR);
      if (count > 0) {
        char type = fd == stdout_pipe[0] ? 'O' : 'E';
        if (write_target_frame(type, output, (uint32_t)count) < 0) {
          (void)kill(target, SIGKILL);
          while (waitpid(target, NULL, 0) < 0 && errno == EINTR) {}
          close(output_fds[0]); close(output_fds[1]);
          return 125;
        }
      } else if (count == 0 || (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
        for (int j = 0; j < 2; j++) {
          if (output_fds[j] == fd) {
            close(fd);
            output_fds[j] = -1;
            open_count--;
            break;
          }
        }
      }
    }
    if (!target_exited) {
      pid_t waited;
      do { waited = waitpid(target, &wait_status, WNOHANG); } while (waited < 0 && errno == EINTR);
      if (waited < 0) {
        int saved = errno;
        (void)kill(target, SIGKILL);
        close(output_fds[0]); close(output_fds[1]);
        return report_target_failure(saved);
      }
      target_exited = waited == target;
    }
    if (target_exited) {
      int remaining = terminate_private_namespace_processes();
      if (remaining < 0) {
        int saved = errno;
        close(output_fds[0]); close(output_fds[1]);
        return report_target_failure(saved);
      }
    }
  }

  if (!target_exited) return report_target_failure(ECHILD);
  unsigned char payload[5];
  int wrapper_exit = 125;
  if (WIFEXITED(wait_status)) {
    payload[0] = 0;
    encode_u32(payload + 1, (uint32_t)WEXITSTATUS(wait_status));
    wrapper_exit = WEXITSTATUS(wait_status);
  } else if (WIFSIGNALED(wait_status)) {
    payload[0] = 1;
    encode_u32(payload + 1, (uint32_t)WTERMSIG(wait_status));
    wrapper_exit = 128 + WTERMSIG(wait_status);
  } else {
    return report_target_failure(ECHILD);
  }
  if (write_target_frame('R', payload, sizeof(payload)) < 0) return 125;
  return wrapper_exit;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--target-wrapper") == 0)
    return target_wrapper(argc, argv);
  int executable_index = 1;
  int cgroup_procs_fd = -1;
  int preserve_helper_fds = 0;
  int cpu_seconds = -1;
  while (executable_index < argc) {
    if (strcmp(argv[executable_index], "--cpu-seconds") == 0) {
      if (executable_index + 1 >= argc || cpu_seconds >= 0) fail(64);
      char *end = NULL;
      errno = 0;
      long seconds = strtol(argv[executable_index + 1], &end, 10);
      if (errno != 0 || end == argv[executable_index + 1] || *end != '\0' || seconds < 1 || seconds > 600)
        fail(64);
      cpu_seconds = (int)seconds;
      executable_index += 2;
    } else if (strcmp(argv[executable_index], "--cgroup-procs-fd") == 0) {
      if (executable_index + 1 >= argc || cgroup_procs_fd >= 0) fail(64);
      char *end = NULL;
      errno = 0;
      long fd = strtol(argv[executable_index + 1], &end, 10);
      if (errno != 0 || end == argv[executable_index + 1] || *end != '\0' || fd != 5)
        fail(64);
      cgroup_procs_fd = (int)fd;
      executable_index += 2;
    } else if (strcmp(argv[executable_index], "--preserve-helper-fds") == 0) {
      if (preserve_helper_fds) fail(64);
      preserve_helper_fds = 1;
      executable_index += 1;
    } else {
      break;
    }
  }
  if (argc <= executable_index || argv[executable_index][0] != '/') fail(64);
  if (cpu_seconds >= 0) {
    struct rlimit cpu_limit;
    cpu_limit.rlim_cur = (rlim_t)cpu_seconds;
    cpu_limit.rlim_max = (rlim_t)cpu_seconds;
    if (setrlimit(RLIMIT_CPU, &cpu_limit) < 0) fail(70);
  }
  if (preserve_helper_fds) {
    set_cloexec(3, 0);
    set_cloexec(4, 0);
  } else {
    set_cloexec(4, 1);
  }
  if (fchdir(3) < 0) fail(70);
  if (!preserve_helper_fds && close(3) < 0) fail(70);
  if (cgroup_procs_fd >= 0) {
    char pid[32];
    int length = snprintf(pid, sizeof(pid), "%ld\n", (long)getpid());
    if (length <= 0 || (size_t)length >= sizeof(pid)) fail(70);
    size_t written = 0;
    while (written < (size_t)length) {
      ssize_t count = write(cgroup_procs_fd, pid + written, (size_t)length - written);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) fail(70);
      written += (size_t)count;
    }
    if (close(cgroup_procs_fd) < 0) fail(70);
  }
  if (preserve_helper_fds) write_helper_status(cgroup_procs_fd >= 0);
  else write_handoff_success();
  execv(argv[executable_index], &argv[executable_index]);
  fail(errno == ENOENT ? 127 : 126);
}
