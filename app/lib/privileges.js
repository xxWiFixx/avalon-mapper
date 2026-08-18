// Определение прав: игра Albion защищена BattlEye и работает с повышенной целостностью.
// Если наш процесс запущен без прав администратора, Windows не доставляет события
// низкоуровневого хука, пока фокус на окне игры — хоткей «молчит» именно во время игры.
// Здесь мы это распознаём, чтобы подсказать пользователю запустить приложение от админа.
const { exec } = require('child_process');

function ps(command, timeoutMs = 4000) {
  return new Promise(resolve => {
    exec(`powershell -NoProfile -NonInteractive -Command "${command}"`,
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

// запущены ли МЫ с правами администратора
async function isElevated() {
  if (process.platform !== 'win32') return true;
  const out = await ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
  return /true/i.test(out);
}

// запущена ли игра и доступна ли она нам для чтения.
// Пустой ExecutablePath у живого процесса = он защищён/выше нас по правам.
async function detectGame() {
  if (process.platform !== 'win32') return { running: false, protected: false };
  // без вложенных двойных кавычек: их съедает командная строка Windows
  const out = await ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Albion-Online.exe' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ExecutablePath }");
  if (!out) return { running: false, protected: false };
  const [, execPath = ''] = out.split('\n')[0].split('|');
  return { running: true, protected: execPath.trim() === '' };
}

// Дешёвая проверка «игра вообще запущена?» — для приостановки опроса экрана.
// tasklist стоит ~50–150 мс против ~500 мс у Get-CimInstance выше, а больше нам и не надо.
function isGameRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise(resolve => {
    exec('tasklist /FI "IMAGENAME eq Albion-Online.exe" /NH',
      { timeout: 3000, windowsHide: true },
      (err, stdout) => resolve(!err && /Albion-Online\.exe/i.test(String(stdout))));
  });
}

// Итоговый вердикт для UI: нужен ли перезапуск от администратора.
// needsAdmin=true только когда игра реально запущена, защищена, а мы без прав.
async function checkHotkeyPrivileges() {
  try {
    const [elevated, game] = await Promise.all([isElevated(), detectGame()]);
    return {
      elevated,
      gameRunning: game.running,
      gameProtected: game.protected,
      needsAdmin: !elevated && game.running && game.protected,
    };
  } catch (e) {
    return { elevated: true, gameRunning: false, gameProtected: false, needsAdmin: false };
  }
}

module.exports = { isElevated, isGameRunning, checkHotkeyPrivileges };
