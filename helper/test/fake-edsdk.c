/*
 * A stand-in for Canon's EDSDK that behaves like an EOS 60D, so the helper's
 * native bindings can be tested on any machine without Canon's SDK or a camera.
 *
 *   gcc -shared -fPIC -o libEDSDK.so fake-edsdk.c            (13.x interface)
 *   gcc -shared -fPIC -DGEN3 -o libEDSDK.so fake-edsdk.c     (3.x interface)
 *
 * Environment: FAKE_RAW_JPEG=1 sends RAW+JPEG pairs; FAKE_RAW_ONLY=1 sends only the RAW;
 * FAKE_NO_CAMERA=1 reports no camera; FAKE_FAIL_SETCAPACITY=1 makes EdsSetCapacity fail;
 * FAKE_BUTTON_SHOT_AFTER_MS=N takes an extra "camera button" shot N ms after the first capture.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef GEN3
typedef uint32_t EdsSize;
#else
typedef uint64_t EdsSize;
#endif

typedef uint32_t EdsError;
typedef EdsError (*ObjectHandler)(uint32_t, void *, void *);
typedef EdsError (*PropertyHandler)(uint32_t, uint32_t, uint32_t, void *);
typedef EdsError (*StateHandler)(uint32_t, uint32_t, void *);

enum Kind { K_LIST = 1, K_CAMERA, K_STREAM, K_EVF, K_ITEM };
typedef struct Ref {
  int kind, refs;
  unsigned char *buf;
  size_t len, cap;
  struct Ref *stream;
  char name[64];
  size_t size;
} Ref;

typedef struct { char szPortName[256]; char szDeviceDescription[256]; uint32_t deviceSubType; uint32_t reserved; } EdsDeviceInfo;
typedef struct { int32_t form, access, numElements; int32_t propDesc[128]; } EdsPropertyDesc;
typedef struct { int32_t numberOfFreeClusters, bytesPerSector, reset; } EdsCapacity;
typedef struct { EdsSize size; int32_t isFolder; uint32_t groupID, option; char szFileName[256]; uint32_t format, dateTime; } EdsDirectoryItemInfo;

static Ref g_camera = {K_CAMERA, 1};
static int g_session, g_capacity_set, g_transfers, g_completes, g_cancels, g_shots;
static ObjectHandler g_obj;
static PropertyHandler g_prop;
static StateHandler g_state;
static void *g_pending_items[8];
static int g_pending_count;
static uint32_t g_pending_props[16];
static int g_pending_prop_count;
static double g_button_due; /* monotonic seconds; 0 = no button shot scheduled */

static uint32_t p_iso = 0x58, p_av = 0x38, p_tv = 0x70, p_wb = 5, p_ae = 3, p_saveto = 1, p_evf = 1;
static const int32_t ISO_DESC[] = {0x00, 0x48, 0x4b, 0x4d, 0x50, 0x53, 0x55, 0x58, 0x5b, 0x5d, 0x60, 0x63, 0x65, 0x68, 0x6b, 0x6d, 0x70, 0x73, 0x75, 0x78};
static const int32_t TV_DESC[] = {0x60, 0x63, 0x64, 0x65, 0x68, 0x6b, 0x6d, 0x70, 0x73, 0x75, 0x78};
static const int32_t AV_DESC[] = {0x20, 0x23, 0x25, 0x28, 0x2b, 0x2d, 0x30, 0x33, 0x35, 0x38, 0x3b, 0x3d, 0x40};

/* A tiny valid-looking JPEG (SOI ... EOI) whose body encodes its purpose. */
static const unsigned char JPEG_HEAD[] = {0xff, 0xd8, 0xff, 0xe0};
static const unsigned char JPEG_TAIL[] = {0xff, 0xd9};

static Ref *new_ref(int kind) {
  Ref *r = calloc(1, sizeof(Ref));
  r->kind = kind;
  r->refs = 1;
  return r;
}

static void put(Ref *s, const void *data, size_t n) {
  if (s->len + n > s->cap) {
    s->cap = (s->len + n) * 2 + 64;
    s->buf = realloc(s->buf, s->cap);
  }
  memcpy(s->buf + s->len, data, n);
  s->len += n;
}

static void fake_jpeg(Ref *s, const char *label, size_t body) {
  put(s, JPEG_HEAD, sizeof JPEG_HEAD);
  put(s, label, strlen(label));
  unsigned char fill = 0x42;
  for (size_t i = 0; i < body; i++) put(s, &fill, 1);
  put(s, JPEG_TAIL, sizeof JPEG_TAIL);
}

static int in_list(const int32_t *list, int n, uint32_t v) {
  for (int i = 0; i < n; i++)
    if ((uint32_t)list[i] == v) return 1;
  return 0;
}

static void queue_prop(uint32_t id) {
  if (g_pending_prop_count < 16) g_pending_props[g_pending_prop_count++] = id;
}

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

EdsError EdsInitializeSDK(void) { return 0; }
EdsError EdsTerminateSDK(void) {
  fprintf(stderr, "[fake-edsdk] terminate: shots=%d transfers=%d completes=%d cancels=%d capacity=%d\n", g_shots, g_transfers, g_completes, g_cancels, g_capacity_set);
  return 0;
}
uint32_t EdsRetain(void *ref) {
  Ref *r = ref;
  if (r && r != &g_camera) r->refs++;
  return r ? r->refs : 0;
}
uint32_t EdsRelease(void *ref) {
  Ref *r = ref;
  if (!r || r == &g_camera) return 1;
  if (--r->refs == 0) {
    free(r->buf);
    free(r);
    return 0;
  }
  return r->refs;
}

EdsError EdsGetCameraList(void **out) {
  *out = new_ref(K_LIST);
  return 0;
}
EdsError EdsGetChildCount(void *ref, uint32_t *count) {
  *count = getenv("FAKE_NO_CAMERA") ? 0 : 1;
  return 0;
}
EdsError EdsGetChildAtIndex(void *ref, int32_t index, void **out) {
  if (index != 0) return 0x00000002;
  *out = &g_camera;
  return 0;
}
EdsError EdsGetDeviceInfo(void *cam, EdsDeviceInfo *info) {
  strcpy(info->szPortName, "usb:fake");
  strcpy(info->szDeviceDescription, "Canon EOS 60D");
  info->deviceSubType = 1;
  return 0;
}
EdsError EdsOpenSession(void *cam) {
  g_session = 1;
  return 0;
}
EdsError EdsCloseSession(void *cam) {
  g_session = 0;
  return 0;
}

static const char *string_prop(uint32_t id) {
  switch (id) {
    case 0x02: return "Canon EOS 60D";
    case 0x15: return "0123456789";
    case 0x07: return "1.1.1";
    default: return NULL;
  }
}

static int uint_prop(uint32_t id, uint32_t **out) {
  static uint32_t battery = 75, shots = 400;
  switch (id) {
    case 0x402: *out = &p_iso; return 1;
    case 0x405: *out = &p_av; return 1;
    case 0x406: *out = &p_tv; return 1;
    case 0x106: *out = &p_wb; return 1;
    case 0x400: *out = &p_ae; return 1;
    case 0x0b: *out = &p_saveto; return 1;
    case 0x500: *out = &p_evf; return 1;
    case 0x08: *out = &battery; return 1;
    case 0x40a: *out = &shots; return 1;
    default: return 0;
  }
}

EdsError EdsGetPropertySize(void *ref, uint32_t id, int32_t param, uint32_t *type, uint32_t *size) {
  if (!g_session) return 0x2003;
  const char *s = string_prop(id);
  uint32_t *u;
  if (s) { *type = 2; *size = (uint32_t)strlen(s) + 1; return 0; }
  if (uint_prop(id, &u)) { *type = 9; *size = 4; return 0; }
  return 0x200a;
}
EdsError EdsGetPropertyData(void *ref, uint32_t id, int32_t param, uint32_t size, void *out) {
  if (!g_session) return 0x2003;
  const char *s = string_prop(id);
  uint32_t *u;
  if (s) { memset(out, 0, size); strncpy(out, s, size - 1); return 0; }
  if (uint_prop(id, &u) && size >= 4) { memcpy(out, u, 4); return 0; }
  return 0x200a; /* e.g. AEModeSelect and LensName on this "camera" */
}
EdsError EdsSetPropertyData(void *ref, uint32_t id, int32_t param, uint32_t size, const void *in) {
  if (!g_session) return 0x2003;
  uint32_t v;
  memcpy(&v, in, 4);
  uint32_t *u;
  if (!uint_prop(id, &u)) return 0x200a;
  if (id == 0x402 && !in_list(ISO_DESC, sizeof ISO_DESC / 4, v)) return 0x201c;
  if (id == 0x406 && (p_ae != 3 || !in_list(TV_DESC, sizeof TV_DESC / 4, v))) return 0x201c;
  if (id == 0x405 && (p_ae != 3 || !in_list(AV_DESC, sizeof AV_DESC / 4, v))) return 0x201c;
  *u = v;
  queue_prop(id);
  return 0;
}
EdsError EdsGetPropertyDesc(void *ref, uint32_t id, EdsPropertyDesc *d) {
  memset(d, 0, sizeof *d);
  const int32_t *list = NULL;
  int n = 0;
  if (id == 0x402) { list = ISO_DESC; n = sizeof ISO_DESC / 4; }
  if (id == 0x406) { list = TV_DESC; n = sizeof TV_DESC / 4; }
  if (id == 0x405) { list = AV_DESC; n = sizeof AV_DESC / 4; }
  if (list) memcpy(d->propDesc, list, n * 4);
  d->numElements = n; /* white balance: no description, like many older bodies */
  return 0;
}

static void make_item(const char *name, size_t size) {
  Ref *item = new_ref(K_ITEM);
  snprintf(item->name, sizeof item->name, "%s", name);
  item->size = size;
  if (g_pending_count < 8) g_pending_items[g_pending_count++] = item;
}

/* One shot: the files the camera would offer for it, per image quality. */
static void shoot(void) {
  char name[32];
  g_shots++;
  if (getenv("FAKE_RAW_JPEG") || getenv("FAKE_RAW_ONLY")) {
    snprintf(name, sizeof name, "IMG_%04d.CR2", g_shots);
    make_item(name, 4096);
  }
  if (!getenv("FAKE_RAW_ONLY")) {
    snprintf(name, sizeof name, "IMG_%04d.JPG", g_shots);
    make_item(name, 200000);
  }
}

EdsError EdsSendCommand(void *cam, uint32_t cmd, int32_t param) {
  if (!g_session) return 0x2003;
  if (cmd == 0x04 && param == 0) return 0;      /* shutter released */
  if (cmd == 0x01) return 0;                    /* keep awake */
  if ((cmd == 0x04 && (param & 0xff) == 3) || cmd == 0x00) {
    if (!(p_saveto & 2) || !g_capacity_set) return 0x8d06; /* nowhere to put the photo */
    shoot();
    const char *after = getenv("FAKE_BUTTON_SHOT_AFTER_MS");
    if (after && g_shots == 1) g_button_due = now_s() + atoi(after) / 1000.0;
    return 0;
  }
  return 0x07;
}
EdsError EdsSendStatusCommand(void *cam, uint32_t cmd, int32_t param) { return 0; }
EdsError EdsSetCapacity(void *cam, EdsCapacity cap) {
  if (getenv("FAKE_FAIL_SETCAPACITY")) return 0x86;
  g_capacity_set = cap.reset == 1 && cap.bytesPerSector == 0x1000 && cap.numberOfFreeClusters == 0x7fffffff;
  return g_capacity_set ? 0 : 0x86;
}
EdsError EdsSetObjectEventHandler(void *cam, uint32_t ev, ObjectHandler h, void *ctx) { g_obj = h; return 0; }
EdsError EdsSetPropertyEventHandler(void *cam, uint32_t ev, PropertyHandler h, void *ctx) { g_prop = h; return 0; }
EdsError EdsSetCameraStateEventHandler(void *cam, uint32_t ev, StateHandler h, void *ctx) { g_state = h; return 0; }

EdsError EdsGetEvent(void) {
  if (g_button_due && now_s() >= g_button_due) {
    g_button_due = 0;
    shoot(); /* someone pressed the camera's own shutter button */
  }
  for (int i = 0; i < g_pending_prop_count; i++)
    if (g_prop) g_prop(0x101, g_pending_props[i], 0, NULL);
  g_pending_prop_count = 0;
  for (int i = 0; i < g_pending_count; i++) {
    g_transfers++;
    if (g_obj) g_obj(0x208, g_pending_items[i], NULL);
  }
  g_pending_count = 0;
  return 0;
}

EdsError EdsGetDirectoryItemInfo(void *ref, EdsDirectoryItemInfo *info) {
  Ref *item = ref;
  memset(info, 0, sizeof *info);
  info->size = (EdsSize)item->size;
  strcpy(info->szFileName, item->name);
  return 0;
}
EdsError EdsDownload(void *ref, EdsSize readSize, void *stream) {
  Ref *item = ref;
  if (readSize != item->size) return 0x86;
  fake_jpeg(stream, item->name, item->size - 6 - strlen(item->name));
  return 0;
}
EdsError EdsDownloadComplete(void *ref) { g_completes++; return 0; }
EdsError EdsDownloadCancel(void *ref) { g_cancels++; return 0; }
EdsError EdsCreateMemoryStream(EdsSize size, void **out) {
  Ref *s = new_ref(K_STREAM);
  if (size) {
    s->cap = (size_t)size;
    s->buf = malloc(s->cap);
  }
  *out = s;
  return 0;
}
EdsError EdsGetPointer(void *stream, void **out) {
  *out = ((Ref *)stream)->buf;
  return 0;
}
EdsError EdsGetLength(void *stream, EdsSize *out) {
  *out = (EdsSize)((Ref *)stream)->len;
  return 0;
}
EdsError EdsCreateEvfImageRef(void *stream, void **out) {
  Ref *e = new_ref(K_EVF);
  e->stream = stream;
  *out = e;
  return 0;
}
EdsError EdsDownloadEvfImage(void *cam, void *evf) {
  if (!(p_evf & 2)) return 0xa102;
  static int frame;
  char label[32];
  snprintf(label, sizeof label, "EVF%06d", frame++);
  fake_jpeg(((Ref *)evf)->stream, label, 30000);
  return 0;
}
