let api = null;

function isGameWindow({ path = '', title = '' }) {
  return /(?:^|[\\/])Albion-Online(?:_BE)?\.exe$/i.test(String(path).trim()) ||
    /^Albion Online(?:\b|$)/i.test(String(title).trim());
}

function windowsApi() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwm = koffi.load('dwmapi.dll');
  const callback = koffi.proto('bool __stdcall GameWindowCallback(void* hwnd, void* data)');
  api = {
    enumWindows: user32.func('bool EnumWindows(GameWindowCallback* cb, void* data)'),
    foregroundWindow: user32.func('void* GetForegroundWindow()'),
    windowPid: user32.func('uint32 GetWindowThreadProcessId(void* hwnd, uint32* pid)'),
    windowText: user32.func('int GetWindowTextW(void* hwnd, void* out, int max)'),
    isVisible: user32.func('bool IsWindowVisible(void* hwnd)'),
    isIconic: user32.func('bool IsIconic(void* hwnd)'),
    windowRect: user32.func('bool GetWindowRect(void* hwnd, void* rect)'),
    frameBounds: dwm.func('int32 DwmGetWindowAttribute(void* hwnd, uint32 attr, void* value, uint32 size)'),
    windowId: hwnd => String(koffi.address(hwnd)),
    openProcess: kernel32.func('void* OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    queryName: kernel32.func('bool QueryFullProcessImageNameW(void* handle, uint32 flags, void* out, uint32* size)'),
    closeHandle: kernel32.func('bool CloseHandle(void* handle)'),
  };
  return api;
}

function wideString(buffer) {
  return buffer.toString('utf16le').split('\0', 1)[0];
}

function processPath(native, pid) {
  // The limited query works for an elevated game without elevating the mapper.
  const handle = native.openProcess(0x1000, false, pid);
  if (!handle) return '';
  try {
    const name = Buffer.alloc(2048);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(1024);
    return native.queryName(handle, 0, name, size) ? wideString(name) : '';
  } finally {
    native.closeHandle(handle);
  }
}

function summarizeWindows(windows) {
  const active = windows.filter(w => w.visible || w.iconic);
  const result = {
    found: active.length > 0,
    minimized: active.length > 0 && active.every(w => w.iconic),
    focused: active.some(w => w.focused && !w.iconic),
  };
  const game = active.find(w => w.focused && !w.iconic && w.bounds) ||
    active.find(w => !w.iconic && w.bounds);
  if (game) result.bounds = game.bounds;
  if (game?.windowId) result.windowId = game.windowId;
  return result;
}

async function state({ identify = isGameWindow } = {}) {
  if (process.platform !== 'win32') return { found: false, minimized: false, focused: false };
  const native = windowsApi();
  const foreground = native.foregroundWindow();
  const foregroundPidBuffer = Buffer.alloc(4);
  if (foreground) native.windowPid(foreground, foregroundPidBuffer);
  const foregroundPid = foregroundPidBuffer.readUInt32LE(0);
  const paths = new Map();
  const windows = [];
  native.enumWindows(hwnd => {
    const visible = !!native.isVisible(hwnd);
    const iconic = !!native.isIconic(hwnd);
    if (!visible && !iconic) return true;

    const pidBuffer = Buffer.alloc(4);
    native.windowPid(hwnd, pidBuffer);
    const pid = pidBuffer.readUInt32LE(0);
    if (!paths.has(pid)) paths.set(pid, processPath(native, pid));
    const titleBuffer = Buffer.alloc(512);
    native.windowText(hwnd, titleBuffer, 256);
    if (identify({ path: paths.get(pid), title: wideString(titleBuffer) })) {
      const rect = Buffer.alloc(16);
      const hasRect = !iconic && native.windowRect(hwnd, rect);
      // Window thumbnails use visible DWM frame bounds, without GetWindowRect's
      // invisible resize border. Both APIs return physical desktop coordinates.
      if (hasRect) {
        const frame = Buffer.alloc(16);
        if (native.frameBounds(hwnd, 9, frame, frame.length) === 0) frame.copy(rect);
      }
      const bounds = hasRect ? {
        left: rect.readInt32LE(0), top: rect.readInt32LE(4),
        right: rect.readInt32LE(8), bottom: rect.readInt32LE(12),
      } : null;
      windows.push({ visible, iconic, focused: pid === foregroundPid, windowId: native.windowId(hwnd),
        bounds: bounds && bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null });
    }
    return true;
  }, null);
  return summarizeWindows(windows);
}

module.exports = { state, isGameWindow, summarizeWindows };
