// Снимок ПРЯМОУГОЛЬНИКА экрана одним вызовом Windows (BitBlt), без потока и без Electron.
//
// Зачем: desktopCapturer прямоугольник не принимает и отдаёт весь экран, тратя ~520 мс,
// причём почти всё это — поднятие сессии захвата, а не копирование пикселей.
// Замер этим модулем на экране 1920x1080: полоска 380x30 — 3–4 мс, весь экран — 26 мс.
// Постоянная сессия захвата при этом не открывается: каждый вызов самостоятельный.
//
// koffi — готовые бинарники, компилировать ничего не нужно.
const koffi = require('koffi');
const F = require('./frame');

const SRCCOPY = 0x00CC0020;
const SM_CXSCREEN = 0, SM_CYSCREEN = 1;

let api = null;
function load() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  api = {
    GetDC: user32.func('void* GetDC(void* hWnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void* hWnd, void* hDC)'),
    GetSystemMetrics: user32.func('int GetSystemMetrics(int nIndex)'),
    CreateCompatibleDC: gdi32.func('void* CreateCompatibleDC(void* hdc)'),
    CreateCompatibleBitmap: gdi32.func('void* CreateCompatibleBitmap(void* hdc, int w, int h)'),
    SelectObject: gdi32.func('void* SelectObject(void* hdc, void* h)'),
    BitBlt: gdi32.func('int BitBlt(void* hdc, int x, int y, int w, int h, void* hdcSrc, int x1, int y1, uint32 rop)'),
    GetDIBits: gdi32.func('int GetDIBits(void* hdc, void* hbm, uint32 start, uint32 lines, void* bits, void* bmi, uint32 usage)'),
    DeleteObject: gdi32.func('int DeleteObject(void* h)'),
    DeleteDC: gdi32.func('int DeleteDC(void* hdc)'),
  };
  return api;
}

// BITMAPINFOHEADER: высота отрицательная — строки идут сверху вниз, как ждёт наш код
function bmiHeader(w, h) {
  const b = Buffer.alloc(52);
  b.writeUInt32LE(40, 0); b.writeInt32LE(w, 4); b.writeInt32LE(-h, 8);
  b.writeUInt16LE(1, 12); b.writeUInt16LE(32, 14); b.writeUInt32LE(0, 16);
  return b;
}

// Битмап и memDC переиспользуем, пока не меняется размер: создание пары стоит ~1 мс,
// а размеры у нас всего два — полоска зоны и весь экран.
let cache = null;   // { w, h, screenDC, memDC, bmp, old }
function surface(w, h) {
  const a = load();
  if (cache && cache.w === w && cache.h === h) return cache;
  release();
  const screenDC = a.GetDC(null);
  const memDC = a.CreateCompatibleDC(screenDC);
  const bmp = a.CreateCompatibleBitmap(screenDC, w, h);
  const old = a.SelectObject(memDC, bmp);
  cache = { w, h, screenDC, memDC, bmp, old, header: bmiHeader(w, h), bits: Buffer.alloc(w * h * 4) };
  return cache;
}
function release() {
  if (!cache) return;
  const a = load();
  try {
    a.SelectObject(cache.memDC, cache.old);
    a.DeleteObject(cache.bmp);
    a.DeleteDC(cache.memDC);
    a.ReleaseDC(null, cache.screenDC);
  } catch { /* окно уже закрыто — освобождать нечего */ }
  cache = null;
}

function screenSize() {
  const a = load();
  return { width: a.GetSystemMetrics(SM_CXSCREEN), height: a.GetSystemMetrics(SM_CYSCREEN) };
}

// Кадр в формате lib/frame (BGRA — ровно то, что отдаёт GDI).
// x/y — координаты в пикселях основного экрана.
function grab(x, y, w, h) {
  const a = load();
  x = Math.round(x); y = Math.round(y); w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const s = surface(w, h);
  if (!a.BitBlt(s.memDC, 0, 0, w, h, s.screenDC, x, y, SRCCOPY)) throw new Error('BitBlt не скопировал кадр');
  if (!a.GetDIBits(s.memDC, s.bmp, 0, h, s.bits, s.header, 0)) throw new Error('GetDIBits не отдал пиксели');
  // Буфер переиспользуется между вызовами — наружу отдаём копию, иначе следующий
  // кадр перезапишет тот, который ещё распознаётся в очереди.
  return F.fromBitmap(Buffer.from(s.bits), w, h);
}

module.exports = { grab, release, available: () => process.platform === 'win32' };
