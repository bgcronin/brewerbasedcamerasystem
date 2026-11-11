// Windows only: stop a stray click in the Camera Link window from freezing it.
//
// A Windows console in "QuickEdit" mode (the default on Windows 10) starts selecting text when it is
// clicked, and while text is selected Windows holds back whatever the program prints next. The program
// then stands still, with photos and live view, until someone presses a key in the window.
// Switching QuickEdit off for this window avoids that. Best effort: any failure leaves things as they were.

const STD_INPUT_HANDLE = 0xfffffff6; // (DWORD)-10
const ENABLE_QUICK_EDIT_MODE = 0x0040;
const ENABLE_EXTENDED_FLAGS = 0x0080;

/** The console mode with QuickEdit switched off. */
export function withoutQuickEdit(mode) {
  return ((mode & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS) >>> 0;
}

/** True if QuickEdit was on and has been switched off. */
export async function disableQuickEdit() {
  if (process.platform !== 'win32') return false;
  try {
    const { default: koffi } = await import('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const GetStdHandle = kernel32.func('void * __stdcall GetStdHandle(uint32_t nStdHandle)');
    const GetConsoleMode = kernel32.func('int __stdcall GetConsoleMode(void *hConsoleHandle, _Out_ uint32_t *lpMode)');
    const SetConsoleMode = kernel32.func('int __stdcall SetConsoleMode(void *hConsoleHandle, uint32_t dwMode)');
    const input = GetStdHandle(STD_INPUT_HANDLE);
    const mode = [0];
    // No console to speak of (started by another program, or input redirected): nothing to do.
    if (!input || !GetConsoleMode(input, mode)) return false;
    if (!(mode[0] & ENABLE_QUICK_EDIT_MODE)) return false;
    return !!SetConsoleMode(input, withoutQuickEdit(mode[0]));
  } catch {
    return false;
  }
}
