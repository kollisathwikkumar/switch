/* Windows handle-relative, no-reparse filesystem primitives for TraceMind. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>

typedef struct HandleOwner {
  int fd;
  HANDLE *anchors;
  size_t anchor_count;
  struct HandleOwner *next;
} HandleOwner;

static HandleOwner *owners = NULL;
static SRWLOCK owners_lock = SRWLOCK_INIT;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value fail_windows(napi_env env, const char *operation, DWORD code) {
  char message[192];
  snprintf(message, sizeof(message), "%s failed (Windows error %lu)", operation, (unsigned long)code);
  return fail(env, message);
}

static int get_fd(napi_env env, napi_value value, int *fd) {
  int32_t number;
  if (napi_get_value_int32(env, value, &number) != napi_ok || number < 0) return 0;
  *fd = number;
  return 1;
}

static HANDLE get_handle(int fd) {
  intptr_t value = _get_osfhandle(fd);
  if (value == -1) return INVALID_HANDLE_VALUE;
  return (HANDLE)value;
}

static wchar_t *utf8_to_wide(const char *text, size_t length) {
  if (!text || length == 0 || length > 65535) return NULL;
  if (memchr(text, '\0', length)) return NULL;
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, NULL, 0);
  if (count <= 0 || count > 32760) return NULL;
  wchar_t *wide = (wchar_t *)calloc((size_t)count + 1, sizeof(wchar_t));
  if (!wide) return NULL;
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)length, wide, count) != count) {
    free(wide);
    return NULL;
  }
  return wide;
}

static int wide_component_is_reserved(const wchar_t *component, size_t length) {
  size_t base_length = 0;
  while (base_length < length && component[base_length] != L'.') base_length++;
  if (base_length == 0 || base_length > 8) return 0;
  wchar_t base[9];
  for (size_t i = 0; i < base_length; i++) base[i] = (wchar_t)towupper(component[i]);
  base[base_length] = L'\0';
  if (!wcscmp(base, L"CON") || !wcscmp(base, L"PRN") || !wcscmp(base, L"AUX") ||
      !wcscmp(base, L"NUL") || !wcscmp(base, L"CONIN$") || !wcscmp(base, L"CONOUT$")) return 1;
  if (base_length == 4 && (!wcsncmp(base, L"COM", 3) || !wcsncmp(base, L"LPT", 3))) {
    if (base[3] >= L'1' && base[3] <= L'9') return 1;
  }
  if (base_length == 4 && (!wcsncmp(base, L"COM", 3) || !wcsncmp(base, L"LPT", 3))) {
    if (base[3] == 0x00b9 || base[3] == 0x00b2 || base[3] == 0x00b3) return 1;
  }
  return 0;
}

static int safe_component(const wchar_t *component, size_t length) {
  if (!component || length == 0 || length > 255) return 0;
  if ((length == 1 && component[0] == L'.') ||
      (length == 2 && component[0] == L'.' && component[1] == L'.')) return 0;
  if (component[length - 1] == L'.' || component[length - 1] == L' ') return 0;
  if (wide_component_is_reserved(component, length)) return 0;
  for (size_t i = 0; i < length; i++) {
    wchar_t ch = component[i];
    if (ch < 0x20 || ch == 0x7f || ch == L'\\' || ch == L'/' || ch == L':') return 0;
  }
  return 1;
}

static int valid_root_path(const wchar_t *path, size_t length) {
  if (!path || length < 4 || length > 32760 ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\') return 0;
  if (path[length - 1] == L'\\' || wcschr(path, L'/')) return 0;
  for (size_t i = 3; i < length; ) {
    size_t start = i;
    while (i < length && path[i] != L'\\') i++;
    if (!safe_component(path + start, i - start)) return 0;
    if (i < length) {
      i++;
      if (i == length) return 0;
    }
  }
  return 1;
}

static wchar_t *path_from_handle(HANDLE handle) {
  DWORD capacity = 32768;
  wchar_t *path = (wchar_t *)calloc(capacity, sizeof(wchar_t));
  if (!path) return NULL;
  DWORD length = GetFinalPathNameByHandleW(handle, path, capacity, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0 || length >= capacity) {
    free(path);
    return NULL;
  }
  return path;
}

static wchar_t *join_component(HANDLE parent, const wchar_t *component) {
  wchar_t *base = path_from_handle(parent);
  if (!base) return NULL;
  size_t base_length = wcslen(base);
  size_t component_length = wcslen(component);
  int needs_separator = base_length > 0 && base[base_length - 1] != L'\\';
  if (base_length + (size_t)needs_separator + component_length + 1 > 32760) {
    free(base);
    return NULL;
  }
  wchar_t *joined = (wchar_t *)calloc(base_length + (size_t)needs_separator + component_length + 1, sizeof(wchar_t));
  if (!joined) {
    free(base);
    return NULL;
  }
  memcpy(joined, base, base_length * sizeof(wchar_t));
  if (needs_separator) joined[base_length++] = L'\\';
  memcpy(joined + base_length, component, component_length * sizeof(wchar_t));
  free(base);
  return joined;
}

static HANDLE open_path(const wchar_t *path, DWORD access) {
  return CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                     FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
}

static int inspect_handle(HANDLE handle, FILE_ATTRIBUTE_TAG_INFO *tag, FILE_STANDARD_INFO *standard) {
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, tag, sizeof(*tag))) return 0;
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, standard, sizeof(*standard))) return 0;
  return 1;
}

static HANDLE open_child_handle(HANDLE parent, const wchar_t *component, DWORD access, int required_directory, int permit_reparse) {
  wchar_t *path = join_component(parent, component);
  if (!path) {
    SetLastError(ERROR_INVALID_NAME);
    return INVALID_HANDLE_VALUE;
  }
  HANDLE handle = open_path(path, access);
  DWORD saved = GetLastError();
  free(path);
  if (handle == INVALID_HANDLE_VALUE) {
    SetLastError(saved);
    return INVALID_HANDLE_VALUE;
  }
  FILE_ATTRIBUTE_TAG_INFO tag;
  FILE_STANDARD_INFO standard;
  if (!inspect_handle(handle, &tag, &standard)) {
    saved = GetLastError();
    CloseHandle(handle);
    SetLastError(saved);
    return INVALID_HANDLE_VALUE;
  }
  if ((!permit_reparse && (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) ||
      (required_directory == 1 && !standard.Directory) ||
      (required_directory == 0 && standard.Directory)) {
    CloseHandle(handle);
    SetLastError(ERROR_CANT_ACCESS_FILE);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static void close_anchor_array(HANDLE *anchors, size_t count) {
  if (!anchors) return;
  for (size_t i = 0; i < count; i++) if (anchors[i] && anchors[i] != INVALID_HANDLE_VALUE) CloseHandle(anchors[i]);
  free(anchors);
}

static int register_owner(int fd, HANDLE *anchors, size_t count) {
  HandleOwner *owner = (HandleOwner *)calloc(1, sizeof(HandleOwner));
  if (!owner) return 0;
  owner->fd = fd;
  owner->anchors = anchors;
  owner->anchor_count = count;
  AcquireSRWLockExclusive(&owners_lock);
  owner->next = owners;
  owners = owner;
  ReleaseSRWLockExclusive(&owners_lock);
  return 1;
}

static int duplicate_parent_anchors(int parent_fd, HANDLE **anchors_out, size_t *count_out) {
  HANDLE parent_handle = get_handle(parent_fd);
  if (parent_handle == INVALID_HANDLE_VALUE) return 0;
  AcquireSRWLockShared(&owners_lock);
  HandleOwner *owner = owners;
  while (owner && owner->fd != parent_fd) owner = owner->next;
  if (!owner) {
    ReleaseSRWLockShared(&owners_lock);
    return 0;
  }
  size_t count = owner->anchor_count + 1;
  HANDLE *anchors = (HANDLE *)calloc(count, sizeof(HANDLE));
  if (!anchors) {
    ReleaseSRWLockShared(&owners_lock);
    return 0;
  }
  size_t copied = 0;
  for (; copied < owner->anchor_count; copied++) {
    if (!DuplicateHandle(GetCurrentProcess(), owner->anchors[copied], GetCurrentProcess(), &anchors[copied],
                         0, FALSE, DUPLICATE_SAME_ACCESS)) break;
  }
  if (copied == owner->anchor_count &&
      DuplicateHandle(GetCurrentProcess(), parent_handle, GetCurrentProcess(), &anchors[copied],
                      0, FALSE, DUPLICATE_SAME_ACCESS)) copied++;
  ReleaseSRWLockShared(&owners_lock);
  if (copied != count) {
    close_anchor_array(anchors, copied);
    return 0;
  }
  *anchors_out = anchors;
  *count_out = count;
  return 1;
}

static int fd_from_handle(HANDLE handle, HANDLE *anchors, size_t anchor_count) {
  int fd = _open_osfhandle((intptr_t)handle, _O_RDONLY | _O_BINARY);
  if (fd < 0) {
    CloseHandle(handle);
    close_anchor_array(anchors, anchor_count);
    return -1;
  }
  if (!register_owner(fd, anchors, anchor_count)) {
    _close(fd);
    close_anchor_array(anchors, anchor_count);
    return -1;
  }
  return fd;
}

static napi_value open_root(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value argv[1], result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok || length == 0 || length > 65535)
    return fail(env, "Invalid Windows project root");
  char *utf8 = (char *)calloc(length + 1, 1);
  if (!utf8) return fail(env, "Out of memory");
  size_t written = 0;
  napi_get_value_string_utf8(env, argv[0], utf8, length + 1, &written);
  wchar_t *path = written == length ? utf8_to_wide(utf8, length) : NULL;
  free(utf8);
  if (!path) return fail(env, "Invalid Windows project root encoding");
  size_t path_length = wcslen(path);
  if (!valid_root_path(path, path_length)) {
    free(path);
    return fail(env, "Invalid Windows project root");
  }
  size_t component_count = 0;
  for (size_t i = 3; i < path_length; i++) if (path[i] == L'\\') component_count++;
  component_count++;
  if (component_count > 512) {
    free(path);
    return fail(env, "Windows project root is too deeply nested");
  }
  HANDLE *anchors = (HANDLE *)calloc(component_count, sizeof(HANDLE));
  if (!anchors) {
    free(path);
    return fail(env, "Out of memory");
  }
  wchar_t drive_root[] = L"\\\\?\\C:\\";
  drive_root[4] = path[0];
  wchar_t drive_type_path[] = L"C:\\";
  drive_type_path[0] = path[0];
  if (GetDriveTypeW(drive_type_path) == DRIVE_REMOTE) {
    free(path);
    close_anchor_array(anchors, 0);
    return fail(env, "Network project roots are unsupported");
  }
  HANDLE current = open_path(drive_root, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES);
  if (current == INVALID_HANDLE_VALUE) {
    DWORD saved = GetLastError();
    free(path);
    close_anchor_array(anchors, 0);
    return fail_windows(env, "Open Windows volume root", saved);
  }
  size_t anchor_count = 0;
  size_t offset = 3;
  while (offset < path_length) {
    size_t end = offset;
    while (end < path_length && path[end] != L'\\') end++;
    size_t component_length = end - offset;
    wchar_t component[256];
    memcpy(component, path + offset, component_length * sizeof(wchar_t));
    component[component_length] = L'\0';
    HANDLE next = open_child_handle(current, component, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, 1, 0);
    if (next == INVALID_HANDLE_VALUE) {
      DWORD saved = GetLastError();
      CloseHandle(current);
      free(path);
      close_anchor_array(anchors, anchor_count);
      return fail_windows(env, "Open Windows project root component", saved);
    }
    anchors[anchor_count++] = current;
    current = next;
    offset = end + 1;
  }
  free(path);
  int fd = fd_from_handle(current, anchors, anchor_count);
  if (fd < 0) return fail(env, "Unable to retain Windows project root handle");
  napi_create_int32(env, fd, &result);
  return result;
}

static int child_component_from_buffer(napi_env env, napi_value value, wchar_t **component_out) {
  void *bytes = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &bytes, &length) != napi_ok || length == 0 || length > 1024) return 0;
  wchar_t *component = utf8_to_wide((const char *)bytes, length);
  if (!component) return 0;
  size_t wide_length = wcslen(component);
  if (!safe_component(component, wide_length)) {
    free(component);
    return 0;
  }
  *component_out = component;
  return 1;
}

static napi_value open_child(napi_env env, napi_callback_info info, int directory) {
  size_t argc = 2;
  napi_value argv[2], result;
  int parent_fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t *component = NULL;
  if (argc != 2 || !get_fd(env, argv[0], &parent_fd) || !child_component_from_buffer(env, argv[1], &component))
    return fail(env, "Invalid Windows child name");
  HANDLE parent = get_handle(parent_fd);
  if (parent == INVALID_HANDLE_VALUE) {
    free(component);
    return fail(env, "Invalid Windows parent handle");
  }
  HANDLE child = open_child_handle(parent, component,
      directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES : GENERIC_READ | FILE_READ_ATTRIBUTES,
      directory ? 1 : 0, 0);
  DWORD saved = GetLastError();
  free(component);
  if (child == INVALID_HANDLE_VALUE) return fail_windows(env, "Open Windows project child", saved);
  HANDLE *anchors = NULL;
  size_t anchor_count = 0;
  if (!duplicate_parent_anchors(parent_fd, &anchors, &anchor_count)) {
    saved = GetLastError();
    CloseHandle(child);
    return fail_windows(env, "Retain Windows parent handle chain", saved ? saved : ERROR_INVALID_HANDLE);
  }
  int fd = fd_from_handle(child, anchors, anchor_count);
  if (fd < 0) return fail(env, "Unable to retain Windows child handle");
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value open_directory(napi_env env, napi_callback_info info) { return open_child(env, info, 1); }
static napi_value open_file(napi_env env, napi_callback_info info) { return open_child(env, info, 0); }

static napi_value classify_child(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  int parent_fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t *component = NULL;
  if (argc != 2 || !get_fd(env, argv[0], &parent_fd) || !child_component_from_buffer(env, argv[1], &component))
    return fail(env, "Invalid Windows child name");
  HANDLE parent = get_handle(parent_fd);
  if (parent == INVALID_HANDLE_VALUE) {
    free(component);
    return fail(env, "Invalid Windows parent handle");
  }
  HANDLE child = open_child_handle(parent, component, FILE_READ_ATTRIBUTES, -1, 1);
  DWORD saved = GetLastError();
  free(component);
  if (child == INVALID_HANDLE_VALUE) return fail_windows(env, "Inspect Windows project child", saved);
  FILE_ATTRIBUTE_TAG_INFO tag;
  FILE_STANDARD_INFO standard;
  if (!inspect_handle(child, &tag, &standard)) {
    saved = GetLastError();
    CloseHandle(child);
    return fail_windows(env, "Inspect Windows project child", saved);
  }
  CloseHandle(child);
  const char *kind = (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? "symlink" :
      standard.Directory ? "directory" : "file";
  napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value list_directory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result, names, complete_value, name_value;
  uint32_t limit;
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 2 || !get_fd(env, argv[0], &fd) || napi_get_value_uint32(env, argv[1], &limit) != napi_ok || limit < 1 || limit > 100000)
    return fail(env, "Invalid Windows directory limit");
  HANDLE handle = get_handle(fd);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "Invalid Windows directory handle");
  wchar_t *base = path_from_handle(handle);
  if (!base) return fail_windows(env, "Resolve Windows directory handle", GetLastError());
  size_t base_length = wcslen(base);
  int separator = base_length > 0 && base[base_length - 1] != L'\\';
  wchar_t *pattern = (wchar_t *)calloc(base_length + (size_t)separator + 2, sizeof(wchar_t));
  if (!pattern) {
    free(base);
    return fail(env, "Out of memory");
  }
  memcpy(pattern, base, base_length * sizeof(wchar_t));
  if (separator) pattern[base_length++] = L'\\';
  pattern[base_length] = L'*';
  free(base);
  WIN32_FIND_DATAW data;
  HANDLE find = FindFirstFileW(pattern, &data);
  DWORD saved = GetLastError();
  free(pattern);
  if (find == INVALID_HANDLE_VALUE) return fail_windows(env, "Enumerate Windows directory", saved);
  napi_create_array(env, &names);
  uint32_t count = 0;
  int complete = 1;
  do {
    if (!wcscmp(data.cFileName, L".") || !wcscmp(data.cFileName, L"..")) continue;
    if (count == limit) {
      complete = 0;
      break;
    }
    int byte_count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, data.cFileName, -1, NULL, 0, NULL, NULL);
    if (byte_count <= 1 || byte_count > 4096) {
      FindClose(find);
      return fail(env, "Unsupported Windows filename encoding");
    }
    char *utf8 = (char *)malloc((size_t)byte_count);
    if (!utf8) {
      FindClose(find);
      return fail(env, "Out of memory");
    }
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, data.cFileName, -1, utf8, byte_count, NULL, NULL) != byte_count) {
      free(utf8);
      FindClose(find);
      return fail(env, "Unsupported Windows filename encoding");
    }
    if (napi_create_buffer_copy(env, (size_t)byte_count - 1, utf8, NULL, &name_value) != napi_ok ||
        napi_set_element(env, names, count, name_value) != napi_ok) {
      free(utf8);
      FindClose(find);
      return fail(env, "Unable to allocate Windows directory entry");
    }
    free(utf8);
    count++;
  } while (FindNextFileW(find, &data));
  saved = GetLastError();
  FindClose(find);
  if (complete && saved != ERROR_NO_MORE_FILES) return fail_windows(env, "Enumerate Windows directory", saved);
  napi_create_object(env, &result);
  napi_get_boolean(env, complete, &complete_value);
  napi_set_named_property(env, result, "names", names);
  napi_set_named_property(env, result, "complete", complete_value);
  return result;
}

static napi_value file_identity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || !get_fd(env, argv[0], &fd)) return fail(env, "Invalid Windows file descriptor");
  HANDLE handle = get_handle(fd);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "Invalid Windows file descriptor");
  FILE_ID_INFO file_id;
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &file_id, sizeof(file_id)))
    return fail_windows(env, "Read Windows file identity", GetLastError());
  char identity[96];
  int used = snprintf(identity, sizeof(identity), "win32:%016llx:", (unsigned long long)file_id.VolumeSerialNumber);
  if (used < 0 || (size_t)used + 32 >= sizeof(identity)) return fail(env, "Windows file identity overflow");
  for (size_t i = 0; i < sizeof(file_id.FileId.Identifier); i++) {
    int written = snprintf(identity + used + i * 2, sizeof(identity) - (size_t)used - i * 2, "%02x",
                           file_id.FileId.Identifier[i]);
    if (written != 2) return fail(env, "Windows file identity formatting failed");
  }
  napi_create_string_utf8(env, identity, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value close_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || !get_fd(env, argv[0], &fd)) return fail(env, "Invalid Windows file descriptor");
  AcquireSRWLockExclusive(&owners_lock);
  HandleOwner **cursor = &owners;
  while (*cursor && (*cursor)->fd != fd) cursor = &(*cursor)->next;
  HandleOwner *owner = *cursor;
  if (owner) *cursor = owner->next;
  ReleaseSRWLockExclusive(&owners_lock);
  if (!owner) return fail(env, "Unknown Windows project handle");
  int status = _close(fd);
  int error = errno;
  close_anchor_array(owner->anchors, owner->anchor_count);
  free(owner);
  if (status != 0) {
    char message[128];
    snprintf(message, sizeof(message), "Close Windows project handle failed (CRT error %d)", error);
    return fail(env, message);
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
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
