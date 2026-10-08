'use strict';
// Own green game surface and red tool only. Stream sees red; OCR sees green.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code; });
} else {
  const { app, BrowserWindow, screen, desktopCapturer } = require('electron');
  const gdi = require('../lib/capture-gdi'), { register, create } = require('../lib/overlay-capture');
  const windowCapture = require('../lib/window-capture'), koffi = require('koffi');
  const gameWindow = require('../lib/game-window');
  const out = path.resolve(__dirname, '../../out'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(out, 'overlay-stream-native-')));
  const affinity = koffi.load('user32.dll').func('bool GetWindowDisplayAffinity(void* hwnd, void* value)');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const pixel = (frame, x, y) => [...frame.data.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 3)];
  const watchdog = setTimeout(() => app.exit(2), 30000);
  let background, overlay;
  app.whenReady().then(async () => {
    const opts = { x: 30, y: 30, width: 300, height: 200, frame: false, show: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { sandbox: true } };
    background = new BrowserWindow({ ...opts, title: 'Mapper game capture test' });
    await background.loadURL('data:text/html,<title>Mapper game capture test</title><body style="margin:0;background:rgb(0,200,0)">');
    background.setAlwaysOnTop(true, 'screen-saver'); background.showInactive(); await wait(300);
    overlay = new BrowserWindow({ ...opts, transparent: true, resizable: false, movable: false, hasShadow: false });
    register(overlay); overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.setIgnoreMouseEvents(true);
    await overlay.loadURL('data:text/html,<body style="margin:0;background:rgb(200,0,0)">');
    overlay.showInactive();
    let hides = 0; overlay.on('hide', () => hides++);
    // Exercise the real Win32 window discovery, HWND and DWM frame bounds;
    // substitute only the test title so the user's live game is never captured.
    const getGame = () => gameWindow.state({ identify: window => window.title === 'Mapper game capture test' });
    const game = windowCapture.create({ getGame, getSources: options => desktopCapturer.getSources(options) });
    const guard = create({ windows: () => [overlay], toPhysical: bounds => screen.dipToScreenRect(null, bounds),
      captureWindow: rect => game.capture(rect) });
    const results = [];
    for (const phase of ['first-show', 'topmost', 'moved', 'interactive']) {
      if (phase === 'topmost') overlay.setAlwaysOnTop(true, 'screen-saver');
      if (phase === 'moved') overlay.setBounds({ x: 31, y: 31, width: 299, height: 199 });
      if (phase === 'interactive') {
        overlay.setIgnoreMouseEvents(false); overlay.setFocusable(true);
        overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.showInactive();
      }
      await wait(250);
      const bounds = overlay.getBounds(), rect = screen.dipToScreenRect(overlay, bounds);
      const normal = gdi.grab(rect.x, rect.y, rect.width, rect.height);
      const clean = await guard.run(rect, () => assert.fail('Overlapping tool would enter GDI screenshot'));
      const display = screen.getDisplayMatching(bounds), desktopBounds = screen.dipToScreenRect(overlay, display.bounds);
      const sources = await desktopCapturer.getSources({ types: ['screen'],
        thumbnailSize: { width: desktopBounds.width, height: desktopBounds.height } });
      const source = sources.find(source => String(source.display_id) === String(display.id));
      assert.ok(source, 'test display');
      const thumbnail = source.thumbnail;
      const desktop = { data: thumbnail.toBitmap(), width: thumbnail.getSize().width };
      const desktopPixel = pixel(desktop, rect.x - desktopBounds.x + 50, rect.y - desktopBounds.y + 50);
      assert.deepEqual(pixel(normal, 50, 50), [0, 0, 200], phase + ' ordinary GDI includes overlay');
      assert.deepEqual(desktopPixel, [0, 0, 200], phase + ' stream/desktop includes overlay');
      assert.deepEqual(pixel(clean, 50, 50), [0, 200, 0], phase + ' OCR sees game under overlay');
      const value = Buffer.alloc(4);
      assert.equal(affinity(koffi.decode(overlay.getNativeWindowHandle(), 'void*'), value), true);
      assert.equal(value.readUInt32LE(), 0, phase + ' no NVIDIA protected-content flag');
      assert.equal(overlay.isContentProtected(), false); assert.equal(overlay.isVisible(), true); assert.equal(hides, 0);
      results.push({ phase, streamPixel: desktopPixel, ocrPixel: pixel(clean, 50, 50), affinity: 0, visible: true, hides });
      console.log('PASS: ' + phase + ' - stream sees overlay; OCR sees game; native affinity is zero; hides=0');
    }
    overlay.hide();
    const value = Buffer.alloc(4); affinity(koffi.decode(overlay.getNativeWindowHandle(), 'void*'), value);
    assert.equal(value.readUInt32LE(), 0, 'Hidden tool also has no protected-content flag');
    const rect = screen.dipToScreenRect(background, background.getBounds());
    let fast = false;
    const clean = await guard.run(rect, () => { fast = true; return gdi.grab(rect.x, rect.y, rect.width, rect.height); });
    assert.equal(fast, true); assert.deepEqual(pixel(clean, 50, 50), [0, 200, 0]);
    console.log('PASS: manually hidden overlay keeps affinity zero; fast GDI path resumes');
    fs.writeFileSync(path.join(out, 'overlay-stream-compatibility.json'), JSON.stringify({ results, hiddenAffinity: 0, fastPath: true }, null, 2));
  }).then(() => {
    clearTimeout(watchdog); overlay?.destroy(); background?.destroy(); gdi.release(); app.exit(0);
  }).catch(error => {
    console.error(error); clearTimeout(watchdog);
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    if (background && !background.isDestroyed()) background.destroy();
    gdi.release(); app.exit(1);
  });
}
