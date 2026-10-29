/* Descriptor-relative, no-follow primitives for the TraceMind filesystem registry. */
#include <node_api.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <errno.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>


static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}
static napi_value fail_errno(napi_env env, const char *operation) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s", operation, strerror(errno));
  return fail(env, message);
}
static int get_fd(napi_env env, napi_value arg, int *fd) {
  int32_t number;
  if (napi_get_value_int32(env, arg, &number) != napi_ok || number < 0) return 0;
  *fd = number;
  return 1;
}
static napi_value file_identity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || !get_fd(env, argv[0], &fd)) return fail(env, "Invalid file descriptor");
  struct stat st;
  if (fstat(fd, &st) < 0) return fail_errno(env, "stat file identity");
  char identity[96];
  int length = snprintf(identity, sizeof(identity), "%ju:%ju", (uintmax_t)st.st_dev, (uintmax_t)st.st_ino);
  if (length < 0 || (size_t)length >= sizeof(identity)) return fail(env, "File identity is too long");
  napi_create_string_utf8(env, identity, (size_t)length, &result);
  return result;
}
static napi_value close_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || !get_fd(env, argv[0], &fd)) return fail(env, "Invalid file descriptor");
  if (close(fd) < 0) return fail_errno(env, "close file descriptor");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}
static napi_value open_root(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value argv[1], result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok || length == 0 || length > 16384)
    return fail(env, "Invalid root path");
  char *path = malloc(length + 1);
  if (!path) return fail(env, "Out of memory");
  size_t written = 0;
  napi_get_value_string_utf8(env, argv[0], path, length + 1, &written);
  if (written != length || path[0] != '/' || memchr(path, '\0', length)) { free(path); return fail(env, "Invalid root path"); }
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
  int saved = errno;
  free(path);
  if (fd < 0) { errno = saved; return fail_errno(env, "open root"); }
  napi_create_int32(env, fd, &result);
  return result;
}
static napi_value open_child(napi_env env, napi_callback_info info, int directory) {
  size_t argc = 2, length = 0;
  napi_value argv[2], result;
  void *bytes = NULL;
  int parent;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 2 || !get_fd(env, argv[0], &parent) || napi_get_buffer_info(env, argv[1], &bytes, &length) != napi_ok || length == 0 || length > 4096)
    return fail(env, "Invalid child name");
  if (memchr(bytes, '/', length) || memchr(bytes, '\0', length) ||
      (length == 1 && !memcmp(bytes, ".", 1)) || (length == 2 && !memcmp(bytes, "..", 2)))
    return fail(env, "Invalid child name");
  char *name = malloc(length + 1);
  if (!name) return fail(env, "Out of memory");
  memcpy(name, bytes, length); name[length] = '\0';
  int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
  if (directory) flags |= O_DIRECTORY;
  int fd = openat(parent, name, flags);
  int saved = errno;
  free(name);
  if (fd < 0) { errno = saved; return fail_errno(env, "open child"); }
  struct stat st;
  if (fstat(fd, &st) < 0) { saved = errno; close(fd); errno = saved; return fail_errno(env, "stat child"); }
  if (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) {
    close(fd); return fail(env, "Unexpected child type");
  }
  napi_create_int32(env, fd, &result);
  return result;
}
static napi_value open_directory(napi_env env, napi_callback_info info) { return open_child(env, info, 1); }
static napi_value open_file(napi_env env, napi_callback_info info) { return open_child(env, info, 0); }
static napi_value classify_child(napi_env env, napi_callback_info info) {
  size_t argc = 2, length = 0;
  napi_value argv[2], result;
  void *bytes = NULL;
  int parent;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 2 || !get_fd(env, argv[0], &parent) || napi_get_buffer_info(env, argv[1], &bytes, &length) != napi_ok || length == 0 || length > 4096 || memchr(bytes, '/', length) || memchr(bytes, '\0', length) || (length == 1 && !memcmp(bytes, ".", 1)) || (length == 2 && !memcmp(bytes, "..", 2))) return fail(env, "Invalid child name");
  char *name = malloc(length + 1);
  if (!name) return fail(env, "Out of memory");
  memcpy(name, bytes, length); name[length] = '\0';
  struct stat st;
  int status = fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW);
  int saved = errno;
  free(name);
  if (status < 0) { errno = saved; return fail_errno(env, "stat child"); }
  const char *type = S_ISDIR(st.st_mode) ? "directory" : S_ISREG(st.st_mode) ? "file" : S_ISLNK(st.st_mode) ? "symlink" : "other";
  napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &result);
  return result;
}
static napi_value list_directory(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2], result, names, complete_value, name_value;
  int fd; uint32_t limit;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 2 || !get_fd(env, argv[0], &fd) || napi_get_value_uint32(env, argv[1], &limit) != napi_ok || limit < 1 || limit > 100000)
    return fail(env, "Invalid directory limit");
  int copy = openat(fd, ".", O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
  if (copy < 0) return fail_errno(env, "open directory stream");
  DIR *dir = fdopendir(copy);
  if (!dir) { int saved = errno; close(copy); errno = saved; return fail_errno(env, "read directory"); }
  napi_create_array(env, &names);
  uint32_t count = 0; int complete = 1; struct dirent *entry;
  errno = 0;
  while ((entry = readdir(dir)) != NULL) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (count == limit) { complete = 0; break; }
    size_t size = strlen(entry->d_name);
    if (napi_create_buffer_copy(env, size, entry->d_name, NULL, &name_value) != napi_ok || napi_set_element(env, names, count++, name_value) != napi_ok) {
      closedir(dir); return fail(env, "Unable to allocate directory entry");
    }
    errno = 0;
  }
  int saved = errno;
  if (closedir(dir) < 0 && saved == 0) saved = errno;
  if (saved) { errno = saved; return fail_errno(env, "read directory"); }
  napi_create_object(env, &result);
  napi_get_boolean(env, complete, &complete_value);
  napi_set_named_property(env, result, "names", names);
  napi_set_named_property(env, result, "complete", complete_value);
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL },
    { "openDirectory", NULL, open_directory, NULL, NULL, NULL, napi_default, NULL },
    { "openFile", NULL, open_file, NULL, NULL, NULL, napi_default, NULL },
    { "classify", NULL, classify_child, NULL, NULL, NULL, napi_default, NULL },
    { "list", NULL, list_directory, NULL, NULL, NULL, napi_default, NULL },
    { "identity", NULL, file_identity, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_fd, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
