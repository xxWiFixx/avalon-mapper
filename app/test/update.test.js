// Проверка обновлений. Здесь важнее всего не «работает ли», а чего оно НЕ делает:
// не качает и не запускает файлы само, не открывает ссылку куда попало, и не мешает
// игроку, когда сети нет.
const { compare, isNewer, safeUrl, fetchInfo, createChecker } = require('../lib/update');

let ok = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

const SRC = 'https://files.example.com/avalon/latest.json';
const okRes = body => ({ ok: true, status: 200, json: async () => body });

(async () => {
  console.log('\n=== сравнение версий ===');

  await t('обычный порядок', () => {
    eq(isNewer('0.3.0', '0.2.0'), true, 'новее');
    eq(isNewer('0.2.0', '0.2.0'), false, 'та же');
    eq(isNewer('0.1.9', '0.2.0'), false, 'старее');
    eq(isNewer('1.0.0', '0.9.9'), true, 'смена мажорной');
  });

  await t('числа сравниваются как числа, а не как строки', () => {
    eq(isNewer('0.10.0', '0.9.0'), true, '10 больше 9');
    eq(isNewer('0.2.10', '0.2.9'), true, 'в патче тоже');
  });

  await t('хвосты и «v» не ломают', () => {
    eq(isNewer('v0.3.0', '0.2.0'), true, 'с буквой v');
    eq(compare('0.3.0-beta', '0.3.0'), 0, 'хвост игнорируем');
  });

  console.log('\n=== куда можно открывать ссылку ===');

  await t('только https', () => {
    eq(safeUrl('http://files.example.com/a.exe', SRC), null, 'http отклоняем');
    eq(safeUrl('file:///C:/x.exe', SRC), null, 'локальный файл отклоняем');
    eq(safeUrl('https://files.example.com/a.exe', SRC) != null, true, 'https принимаем');
  });

  await t('только тот же хост, что у файла версий', () => {
    eq(safeUrl('https://evil.example.net/a.exe', SRC), null, 'чужой хост отклоняем');
    eq(safeUrl('https://files.example.com/sub/a.exe', SRC) != null, true, 'свой хост принимаем');
  });

  console.log('\n=== адрес: репозиторий или свой файл ===');

  await t('«owner/repo» и ссылки на GitHub становятся адресом API выпусков', () => {
    const { normalizeUrl } = require('../lib/update');
    const want = 'https://api.github.com/repos/xxWiFixx/avalon-mapper/releases/latest';
    eq(normalizeUrl('xxWiFixx/avalon-mapper'), want, 'коротко');
    eq(normalizeUrl('https://github.com/xxWiFixx/avalon-mapper'), want, 'ссылкой');
    eq(normalizeUrl('https://github.com/xxWiFixx/avalon-mapper/releases'), want, 'на выпуски');
  });

  await t('свой файл остаётся как есть, мусор отбрасывается', () => {
    const { normalizeUrl } = require('../lib/update');
    eq(normalizeUrl('https://files.example.com/latest.json'), 'https://files.example.com/latest.json', 'свой файл');
    eq(normalizeUrl('мусор'), '', 'мусор');
    eq(normalizeUrl(''), '', 'пусто');
  });

  await t('ответ GitHub понимается без переделки формата', async () => {
    const api = 'https://api.github.com/repos/a/b/releases/latest';
    const info = await fetchInfo(api, { fetchImpl: async () => okRes({
      // Фикстура как у настоящего GitHub: поле url там есть ВСЕГДА и ведёт на JSON
      // этого же API. Раньше его в фикстуре не было, и тест не замечал, что кнопка
      // «вышла версия» открывает игроку сырой JSON вместо страницы выпуска.
      tag_name: 'v0.3.0',
      url: 'https://api.github.com/repos/a/b/releases/123456',
      html_url: 'https://github.com/a/b/releases/tag/v0.3.0', body: 'что нового',
    }) });
    eq(info.version, 'v0.3.0', 'версия из тега');
    eq(info.url, 'https://github.com/a/b/releases/tag/v0.3.0', 'ведём на страницу выпуска, а не в JSON API');
    eq(isNewer(info.version, '0.2.0'), true, 'сравнение с «v» работает');
  });

  await t('свой файл версий: ссылка берётся из url — html_url там нет', async () => {
    const src = 'https://files.example.com/avalon/latest.json';
    const info = await fetchInfo(src, { fetchImpl: async () => okRes({
      version: '0.3.0', url: 'https://files.example.com/avalon/AvalonMapper-0.3.0-setup.exe', notes: 'правки',
    }) });
    eq(info.url, 'https://files.example.com/avalon/AvalonMapper-0.3.0-setup.exe', 'ведём на установщик');
  });

  await t('подделка под github не проходит', () => {
    eq(safeUrl('https://github.com.evil.net/a', 'https://api.github.com/repos/a/b/releases/latest'), null, 'чужой домен');
  });

  // Находка ультраревью: сравнение двух последних частей имени считало соседей по
  // github.io (а также pages.dev, co.uk) одним владельцем. Для дефолтного api.github.com
  // это не задето, но самохостинг на страницах GitHub — ровно тот случай, ради которого
  // проверка и написана.
  await t('соседи по многосоставному суффиксу — разные владельцы', () => {
    const src = 'https://alice.github.io/avalon/latest.json';
    eq(safeUrl('https://evil.github.io/a.exe', src), null, 'сосед по github.io — чужой');
    eq(safeUrl('https://alice.github.io/a.exe', src) != null, true, 'свой же хост — можно');
    eq(safeUrl('https://evil.co.uk/a.exe', 'https://shop.co.uk/latest.json'), null, 'сосед по co.uk — чужой');
    eq(safeUrl('https://evil.pages.dev/a.exe', 'https://mine.pages.dev/latest.json'), null, 'сосед по pages.dev — чужой');
  });

  await t('поддомен того же владельца по-прежнему свой', () => {
    const api = 'https://api.github.com/repos/a/b/releases/latest';
    eq(safeUrl('https://github.com/a/b/releases/tag/v1', api) != null, true, 'github.com при источнике api.github.com');
    eq(safeUrl('https://dl.files.example.com/a.exe', 'https://files.example.com/latest.json') != null, true, 'поддомен своего хоста');
  });

  console.log('\n=== разбор ответа ===');

  await t('обычный ответ', async () => {
    const info = await fetchInfo(SRC, { fetchImpl: async () => okRes({ version: '0.3.0', url: 'https://files.example.com/a.exe', notes: 'что нового' }) });
    eq(info.version, '0.3.0', 'версия');
    eq(info.notes, 'что нового', 'заметки');
  });

  await t('ссылки нет или она чужая — версия всё равно видна', async () => {
    const info = await fetchInfo(SRC, { fetchImpl: async () => okRes({ version: '0.3.0', url: 'https://evil.example.net/a.exe' }) });
    eq(info.version, '0.3.0', 'версия');
    eq(info.url, null, 'ссылка отброшена');
  });

  await t('ответ без версии — ошибка, а не тишина', async () => {
    let err = null;
    try { await fetchInfo(SRC, { fetchImpl: async () => okRes({ hello: 1 }) }); } catch (e) { err = e; }
    eq(err != null, true, 'бросили ошибку');
  });

  console.log('\n=== поведение проверяльщика ===');

  await t('нашли новую — сообщаем один раз', async () => {
    const found = [];
    const c = createChecker({
      currentVersion: '0.2.0', getUrl: () => SRC, onFound: i => found.push(i.version),
      fetchImpl: async () => okRes({ version: '0.3.0', url: 'https://files.example.com/a.exe' }),
    });
    await c.check(true);
    await c.check(true);
    eq(found.length, 1, 'одно сообщение на одну версию');
    eq(c.status().latest, '0.3.0', 'состояние');
  });

  await t('версия та же — молчим', async () => {
    const found = [];
    const c = createChecker({
      currentVersion: '0.3.0', getUrl: () => SRC, onFound: i => found.push(i),
      fetchImpl: async () => okRes({ version: '0.3.0' }),
    });
    await c.check(true);
    eq(found.length, 0, 'ничего не сообщили');
    eq(c.status().latest, null, 'обновления нет');
  });

  await t('нет сети — не падаем и не беспокоим', async () => {
    const c = createChecker({
      currentVersion: '0.2.0', getUrl: () => SRC,
      fetchImpl: async () => { throw new Error('сеть недоступна'); },
    });
    await c.check(true);
    eq(c.status().latest, null, 'обновления не выдумали');
    eq(c.status().error != null, true, 'причина сохранена в состоянии');
  });

  await t('адрес не задан — не ходим никуда', async () => {
    let calls = 0;
    const c = createChecker({
      currentVersion: '0.2.0', getUrl: () => '',
      fetchImpl: async () => { calls++; return okRes({ version: '9.9.9' }); },
    });
    await c.check(true);
    eq(calls, 0, 'запросов не было');
  });

  console.log(`\n${fail ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ЗЕЛЕНО'}: ${ok}/${ok + fail} проверок пройдено`);
  process.exit(fail ? 1 : 0);
})();
