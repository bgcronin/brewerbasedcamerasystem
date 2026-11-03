// koffi bindings for the parts of Canon's EDSDK that Lumen uses.
import path from 'node:path';
import koffi from 'koffi';
import { EdsError, Err } from './constants.js';

let structsDefined = null;

function defineTypes(gen) {
  if (structsDefined) return structsDefined;
  const sizeT = gen >= 13 ? 'uint64_t' : 'uint32_t';
  const types = {
    sizeT,
    DeviceInfo: koffi.struct('EdsDeviceInfo', {
      szPortName: koffi.array('char', 256, 'String'),
      szDeviceDescription: koffi.array('char', 256, 'String'),
      deviceSubType: 'uint32_t',
      reserved: 'uint32_t',
    }),
    PropertyDesc: koffi.struct('EdsPropertyDesc', {
      form: 'int32_t',
      access: 'int32_t',
      numElements: 'int32_t',
      propDesc: koffi.array('int32_t', 128, 'Array'),
    }),
    Capacity: koffi.struct('EdsCapacity', {
      numberOfFreeClusters: 'int32_t',
      bytesPerSector: 'int32_t',
      reset: 'int32_t',
    }),
    DirectoryItemInfo: koffi.struct('EdsDirectoryItemInfo', {
      size: sizeT,
      isFolder: 'int32_t',
      groupID: 'uint32_t',
      option: 'uint32_t',
      szFileName: koffi.array('char', 256, 'String'),
      format: 'uint32_t',
      dateTime: 'uint32_t',
    }),
    ObjectHandler: koffi.proto('uint32_t __stdcall EdsObjectEventHandler(uint32_t inEvent, void *inRef, void *inContext)'),
    PropertyHandler: koffi.proto('uint32_t __stdcall EdsPropertyEventHandler(uint32_t inEvent, uint32_t inPropertyID, uint32_t inParam, void *inContext)'),
    StateHandler: koffi.proto('uint32_t __stdcall EdsStateEventHandler(uint32_t inEvent, uint32_t inEventData, void *inContext)'),
  };
  structsDefined = types;
  return types;
}

/** Windows: let EDSDK.dll find EdsImage.dll and friends sitting next to it. */
function prepareWindowsDllSearch(dir) {
  process.env.PATH = `${dir};${process.env.PATH ?? ''}`;
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const SetDllDirectoryW = kernel32.func('int __stdcall SetDllDirectoryW(const char16_t *lpPathName)');
    SetDllDirectoryW(dir);
  } catch {
    /* PATH is enough on most systems */
  }
}

export function loadEdsdk(sdk) {
  const t = defineTypes(sdk.generation);
  if (process.platform === 'win32') prepareWindowsDllSearch(path.dirname(sdk.libPath));
  let lib;
  try {
    lib = koffi.load(sdk.libPath);
  } catch (e) {
    const hint =
      process.platform === 'darwin' && /incompatible architecture|wrong architecture|mach-o/i.test(String(e.message))
        ? ' This Canon SDK build does not match this Mac’s processor. Use a newer EDSDK with Apple Silicon support, or run Node for Intel (Rosetta).'
        : process.platform === 'win32' && /193|not a valid Win32/i.test(String(e.message))
          ? ' This looks like the 32-bit EDSDK. Use the EDSDK_64 folder from Canon’s download.'
          : '';
    throw new Error(`Could not load the Canon SDK at ${sdk.libPath}: ${e.message}.${hint}`);
  }

  const S = t.sizeT;
  const f = (sig) => lib.func(sig);
  const api = {
    EdsInitializeSDK: f('uint32_t __stdcall EdsInitializeSDK()'),
    EdsTerminateSDK: f('uint32_t __stdcall EdsTerminateSDK()'),
    EdsRetain: f('uint32_t __stdcall EdsRetain(void *inRef)'),
    EdsRelease: f('uint32_t __stdcall EdsRelease(void *inRef)'),
    EdsGetCameraList: f('uint32_t __stdcall EdsGetCameraList(_Out_ void **outCameraListRef)'),
    EdsGetChildCount: f('uint32_t __stdcall EdsGetChildCount(void *inRef, _Out_ uint32_t *outCount)'),
    EdsGetChildAtIndex: f('uint32_t __stdcall EdsGetChildAtIndex(void *inRef, int32_t inIndex, _Out_ void **outRef)'),
    EdsGetDeviceInfo: f('uint32_t __stdcall EdsGetDeviceInfo(void *inCameraRef, _Out_ EdsDeviceInfo *outDeviceInfo)'),
    EdsOpenSession: f('uint32_t __stdcall EdsOpenSession(void *inCameraRef)'),
    EdsCloseSession: f('uint32_t __stdcall EdsCloseSession(void *inCameraRef)'),
    EdsGetPropertySize: f(
      'uint32_t __stdcall EdsGetPropertySize(void *inRef, uint32_t inPropertyID, int32_t inParam, _Out_ uint32_t *outDataType, _Out_ uint32_t *outSize)',
    ),
    EdsGetPropertyData: f(
      'uint32_t __stdcall EdsGetPropertyData(void *inRef, uint32_t inPropertyID, int32_t inParam, uint32_t inPropertySize, _Out_ uint8_t *outPropertyData)',
    ),
    EdsSetPropertyData: f(
      'uint32_t __stdcall EdsSetPropertyData(void *inRef, uint32_t inPropertyID, int32_t inParam, uint32_t inPropertySize, const uint8_t *inPropertyData)',
    ),
    EdsGetPropertyDesc: f('uint32_t __stdcall EdsGetPropertyDesc(void *inRef, uint32_t inPropertyID, _Out_ EdsPropertyDesc *outPropertyDesc)'),
    EdsSendCommand: f('uint32_t __stdcall EdsSendCommand(void *inCameraRef, uint32_t inCommand, int32_t inParam)'),
    EdsSendStatusCommand: f('uint32_t __stdcall EdsSendStatusCommand(void *inCameraRef, uint32_t inStatusCommand, int32_t inParam)'),
    EdsSetCapacity: f('uint32_t __stdcall EdsSetCapacity(void *inCameraRef, EdsCapacity inCapacity)'),
    EdsGetDirectoryItemInfo: f('uint32_t __stdcall EdsGetDirectoryItemInfo(void *inDirItemRef, _Out_ EdsDirectoryItemInfo *outDirItemInfo)'),
    EdsDownload: f(`uint32_t __stdcall EdsDownload(void *inDirItemRef, ${S} inReadSize, void *outStream)`),
    EdsDownloadCancel: f('uint32_t __stdcall EdsDownloadCancel(void *inDirItemRef)'),
    EdsDownloadComplete: f('uint32_t __stdcall EdsDownloadComplete(void *inDirItemRef)'),
    EdsCreateMemoryStream: f(`uint32_t __stdcall EdsCreateMemoryStream(${S} inBufferSize, _Out_ void **outStream)`),
    EdsGetPointer: f('uint32_t __stdcall EdsGetPointer(void *inStream, _Out_ void **outPointer)'),
    EdsGetLength: f(`uint32_t __stdcall EdsGetLength(void *inStream, _Out_ ${S} *outLength)`),
    EdsCreateEvfImageRef: f('uint32_t __stdcall EdsCreateEvfImageRef(void *inStreamRef, _Out_ void **outEvfImageRef)'),
    EdsDownloadEvfImage: f('uint32_t __stdcall EdsDownloadEvfImage(void *inCameraRef, void *inEvfImageRef)'),
    EdsSetObjectEventHandler: f(
      'uint32_t __stdcall EdsSetObjectEventHandler(void *inCameraRef, uint32_t inEvent, EdsObjectEventHandler *inHandler, void *inContext)',
    ),
    EdsSetPropertyEventHandler: f(
      'uint32_t __stdcall EdsSetPropertyEventHandler(void *inCameraRef, uint32_t inEvent, EdsPropertyEventHandler *inHandler, void *inContext)',
    ),
    EdsSetCameraStateEventHandler: f(
      'uint32_t __stdcall EdsSetCameraStateEventHandler(void *inCameraRef, uint32_t inEvent, EdsStateEventHandler *inHandler, void *inContext)',
    ),
  };
  // EdsGetEvent pumps events for apps without a window message loop. Not every build exports it.
  try {
    api.EdsGetEvent = f('uint32_t __stdcall EdsGetEvent()');
  } catch {
    api.EdsGetEvent = null;
  }
  return { api, types: t, lib };
}

/** Throw a readable error for anything but EDS_ERR_OK. */
export function check(code, where) {
  if ((code >>> 0) !== Err.OK) throw new EdsError(code, where);
}

/**
 * macOS delivers EDSDK events through the main run loop, which Node doesn't
 * spin. Running it briefly on each tick lets those events through.
 */
export function makeRunLoopPump() {
  if (process.platform !== 'darwin') return () => {};
  try {
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const CFStringCreateWithCString = cf.func('void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)');
    const CFRunLoopRunInMode = cf.func('int32_t CFRunLoopRunInMode(void *mode, double seconds, uint8_t returnAfterSourceHandled)');
    const mode = CFStringCreateWithCString(null, 'kCFRunLoopDefaultMode', 0x08000100);
    return () => {
      CFRunLoopRunInMode(mode, 0, 1);
    };
  } catch {
    return () => {};
  }
}
