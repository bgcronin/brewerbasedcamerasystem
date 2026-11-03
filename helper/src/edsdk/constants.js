// Constants from Canon's EDSDK headers (EDSDKTypes.h / EDSDKErrors.h).
// These values are stable across EDSDK 3.x and 13.x.

export const PropID = {
  ProductName: 0x00000002,
  BodyIDEx: 0x00000015,
  FirmwareVersion: 0x00000007,
  BatteryLevel: 0x00000008,
  SaveTo: 0x0000000b,
  ImageQuality: 0x00000100,
  WhiteBalance: 0x00000106,
  AEMode: 0x00000400,
  DriveMode: 0x00000401,
  ISOSpeed: 0x00000402,
  MeteringMode: 0x00000403,
  AFMode: 0x00000404,
  Av: 0x00000405,
  Tv: 0x00000406,
  ExposureCompensation: 0x00000407,
  AvailableShots: 0x0000040a,
  LensName: 0x0000040d,
  AEModeSelect: 0x00000436,
  Evf_OutputDevice: 0x00000500,
  Evf_Mode: 0x00000501,
};

export const SaveTo = { Camera: 1, Host: 2, Both: 3 };
export const EvfOutputDevice = { TFT: 1, PC: 2 };

export const CameraCommand = {
  TakePicture: 0x00000000,
  ExtendShutDownTimer: 0x00000001,
  PressShutterButton: 0x00000004,
};

export const ShutterButton = {
  Off: 0x00000000,
  Halfway: 0x00000001,
  Completely: 0x00000003,
  Halfway_NonAF: 0x00010001,
  Completely_NonAF: 0x00010003,
};

export const StatusCommand = { UILock: 0, UIUnLock: 1 };

export const ObjectEvent = {
  All: 0x00000200,
  DirItemCreated: 0x00000204,
  DirItemRequestTransfer: 0x00000208,
};

export const PropertyEvent = {
  All: 0x00000100,
  PropertyChanged: 0x00000101,
  PropertyDescChanged: 0x00000102,
};

export const StateEvent = {
  All: 0x00000300,
  Shutdown: 0x00000301,
  WillSoonShutDown: 0x00000303,
  CaptureError: 0x00000305,
  InternalError: 0x00000306,
};

export const DataType = {
  String: 2,
  Int32: 8,
  UInt32: 9,
};

export const Err = {
  OK: 0x00000000,
  NOT_SUPPORTED: 0x00000007,
  DEVICE_NOT_FOUND: 0x00000080,
  DEVICE_BUSY: 0x00000081,
  DEVICE_INVALID: 0x00000082,
  DEVICE_MEMORY_FULL: 0x00000084,
  DEVICE_NO_DISK: 0x00000087,
  COMM_PORT_IS_IN_USE: 0x000000c0,
  COMM_DISCONNECTED: 0x000000c1,
  COMM_DEVICE_INCOMPATIBLE: 0x000000c2,
  SESSION_NOT_OPEN: 0x00002003,
  DEVICEPROP_NOT_SUPPORTED: 0x0000200a,
  PTP_DEVICE_BUSY: 0x00002019,
  INVALID_DEVICEPROP_VALUE: 0x0000201c,
  SESSION_ALREADY_OPEN: 0x0000201e,
  NOT_CAMERA_SUPPORT_SDK_VERSION: 0x00002021,
  TAKE_PICTURE_AF_NG: 0x00008d01,
  TAKE_PICTURE_NO_CARD_NG: 0x00008d06,
  TAKE_PICTURE_CARD_NG: 0x00008d07,
  TAKE_PICTURE_CARD_PROTECT_NG: 0x00008d08,
  TAKE_PICTURE_NO_LENS_NG: 0x00008d0b,
  OBJECT_NOTREADY: 0x0000a102,
};

const MESSAGES = {
  [Err.DEVICE_BUSY]: 'The camera is busy. Try again in a moment.',
  [Err.PTP_DEVICE_BUSY]: 'The camera is busy. Try again in a moment.',
  [Err.COMM_PORT_IS_IN_USE]: 'Another program is using the camera. Quit EOS Utility (and any photo import app), then reconnect.',
  [Err.COMM_DISCONNECTED]: 'The camera was disconnected.',
  [Err.COMM_DEVICE_INCOMPATIBLE]: 'This camera is not supported by the installed Canon SDK.',
  [Err.NOT_CAMERA_SUPPORT_SDK_VERSION]:
    'This version of the Canon SDK does not support this camera. For older bodies such as the EOS 60D, use EDSDK 3.x.',
  [Err.DEVICE_MEMORY_FULL]: 'The memory card is full.',
  [Err.DEVICE_NO_DISK]: 'There is no memory card in the camera.',
  [Err.TAKE_PICTURE_NO_CARD_NG]: 'There is no memory card in the camera.',
  [Err.TAKE_PICTURE_CARD_NG]: 'The memory card has a problem. Check it in the camera.',
  [Err.TAKE_PICTURE_CARD_PROTECT_NG]: 'The memory card is write-protected.',
  [Err.TAKE_PICTURE_AF_NG]: 'The camera could not focus. Switch the lens to MF.',
  [Err.TAKE_PICTURE_NO_LENS_NG]: 'The camera reports no lens. Check the lens or slit lamp adapter is seated, and set the mode dial to M.',
  [Err.INVALID_DEVICEPROP_VALUE]: 'The camera rejected that setting in its current mode.',
  [Err.DEVICEPROP_NOT_SUPPORTED]: 'This camera does not support that setting.',
  [Err.NOT_SUPPORTED]: 'This camera does not support that operation.',
};

export function errorMessage(code) {
  return MESSAGES[code] ?? `Canon SDK error 0x${(code >>> 0).toString(16).padStart(8, '0')}`;
}

export class EdsError extends Error {
  constructor(code, where) {
    super(`${errorMessage(code)}${where ? ` (${where})` : ''}`);
    this.code = code >>> 0;
    this.where = where;
  }
}
