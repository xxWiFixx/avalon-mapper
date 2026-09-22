const fs = require('fs');
const path = require('path');

function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ожидался объект JSON');
    return value;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // Сохраняем исходный файл до восстановления настроек по умолчанию.
    if (!(err instanceof SyntaxError) && err.message !== 'ожидался объект JSON') throw err;
    const backup = file + '.corrupt-' + Date.now();
    fs.copyFileSync(file, backup);
    console.warn('[данные] повреждённый JSON сохранён:', backup);
    return {};
  }
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // До успешной записи нового файла предыдущая версия остаётся целой.
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 1));
  fs.renameSync(temp, file);
}

module.exports = { readObject, writeObject };
