#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (fchdir(3) < 0) {
    perror("fchdir project root");
    return 70;
  }
  if (close(3) < 0) {
    perror("close project root descriptor");
    return 70;
  }
  argv[0] = "git";
  execvp("git", argv);
  perror("execvp git");
  return errno == ENOENT ? 127 : 126;
}
