#!/usr/bin/env node
// Разовый импорт ассетов карт зон Авалона и иконок активностей
// с albiononlinebuilds.com в app/assets/**.
//
// Запуск:  node tools/fetch-assets.js
// Зависимостей нет — только встроенные fetch/fs/path.
//
// Скрипт идемпотентен: уже скачанные валидные файлы пропускаются,
// поэтому повторный запуск отрабатывает за секунды и дотягивает только
// то, что в прошлый раз не получилось.

const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------- настройки

const ROOT = path.resolve(__dirname, '..')
const ZONES_JSON = path.join(ROOT, 'zones.json')
const ASSETS_DIR = path.join(ROOT, 'app', 'assets')
const MAPS_DIR = path.join(ASSETS_DIR, 'avalon-maps')
const ICONS_DIR = path.join(ASSETS_DIR, 'avalon-icons')
const MANIFEST = path.join(ASSETS_DIR, 'manifest.json')

const BASE_MAPS = 'https://www.albiononlinebuilds.com/avalon-maps'
const BASE_ICONS = 'https://www.albiononlinebuilds.com/avalon-icons'

// Ключи активностей — как в zones.json и в контракте путей
const ICON_KEYS = ['green', 'blue', 'rock', 'wood', 'hide', 'ore', 'dg_solo', 'dg_group']

const CONCURRENCY = 6      // не больше 6 одновременных запросов — вежливо к сайту
const POLITE_DELAY = 120   // мс паузы между запросами внутри одного воркера
const RETRIES = 3          // всего попыток на файл
const RETRY_BASE = 800     // мс, задержка нарастает: 800 / 1600 / 3200
const TIMEOUT = 30000      // мс на один запрос
const PROGRESS_EVERY = 25  // как часто печатать прогресс

// Минимальный разумный размер файла — свой для каждого вида ассета.
// Карты весят ~65 КБ, так что порог в 1 КБ ловит обрубки.
// Иконки же реально бывают меньше килобайта (green 1.8 КБ, dg_solo 0.8 КБ),
// поэтому для них порог низкий — иначе валидные файлы летят в missing.
const MIN_SIZE = { map: 1024, icon: 100 }

// User-Agent как у Chrome — без него сайт может ответить 403
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'image/webp,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.albiononlinebuilds.com/'
}

// ---------------------------------------------------------------- утилиты

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Проверка сигнатуры WebP: байты 0..3 = "RIFF", байты 8..11 = "WEBP"
function isWebp (buf) {
  if (!buf || buf.length < 12) return false
  return buf.slice(0, 4).toString('latin1') === 'RIFF' &&
         buf.slice(8, 12).toString('latin1') === 'WEBP'
}

// Файл уже на месте и выглядит целым?
function alreadyOk (file, minSize) {
  try {
    const st = fs.statSync(file)
    if (st.size < minSize) return false
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(12)
    fs.readSync(fd, head, 0, 12, 0)
    fs.closeSync(fd)
    return isWebp(head)
  } catch {
    return false
  }
}

function rmQuiet (file) {
  try { fs.unlinkSync(file) } catch {}
}

// Скачивание одного файла с ретраями.
// Возвращает {status: 'downloaded'|'skipped'|'missing', bytes, reason}
async function download (url, file, minSize) {
  if (alreadyOk(file, minSize)) {
    return { status: 'skipped', bytes: fs.statSync(file).size }
  }

  let lastReason = 'unknown'

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    if (attempt > 1) await sleep(RETRY_BASE * Math.pow(2, attempt - 2))

    let res
    try {
      res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'follow'
      })
    } catch (e) {
      lastReason = 'network: ' + (e && e.message ? e.message : String(e))
      continue // сетевую ошибку ретраим
    }

    // 4xx (кроме 429) — ретраить бессмысленно, файла просто нет
    if (!res.ok) {
      lastReason = 'HTTP ' + res.status
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break
      continue // 5xx и 429 — ретраим
    }

    let buf
    try {
      buf = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastReason = 'read body: ' + (e && e.message ? e.message : String(e))
      continue
    }

    // Валидация: непустой и действительно WebP.
    // Сайт на несуществующий путь может отдать 200 + HTML — эта проверка её ловит.
    if (!isWebp(buf)) {
      lastReason = buf.length === 0
        ? 'пустой ответ'
        : 'не WebP (' + buf.length + ' Б, сигнатура ' +
          JSON.stringify(buf.slice(0, 4).toString('latin1')) + ')'
      rmQuiet(file)
      break // отдали не картинку — повтор не поможет
    }

    // Сигнатура на месте, но файл подозрительно мал — похоже на обрубок,
    // такое имеет смысл перекачать.
    if (buf.length < minSize) {
      lastReason = 'слишком мал: ' + buf.length + ' Б (минимум ' + minSize + ')'
      rmQuiet(file)
      continue
    }

    // Пишем через временный файл, чтобы не оставить обрубок при падении
    const tmp = file + '.part'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, file)
    return { status: 'downloaded', bytes: buf.length }
  }

  rmQuiet(file)
  return { status: 'missing', bytes: 0, reason: lastReason }
}

// Простейший пул воркеров на CONCURRENCY параллельных задач
async function runPool (tasks, onDone) {
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      const t = tasks[i]
      const res = await download(t.url, t.file, MIN_SIZE[t.kind])
      onDone(t, res)
      await sleep(POLITE_DELAY)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker)
  )
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' МБ'

// ---------------------------------------------------------------- main

async function main () {
  if (typeof fetch !== 'function') {
    console.error('Нужен Node 18+ со встроенным fetch. Текущий: ' + process.version)
    process.exit(1)
  }

  fs.mkdirSync(MAPS_DIR, { recursive: true })
  fs.mkdirSync(ICONS_DIR, { recursive: true })

  const zones = JSON.parse(fs.readFileSync(ZONES_JSON, 'utf8'))
  const names = [...new Set(zones.map((z) => z.name))]
  console.log('Зон в zones.json: ' + zones.length + ' (уникальных имён: ' + names.length + ')')

  const tasks = [
    ...ICON_KEYS.map((k) => ({
      kind: 'icon',
      key: k,
      url: BASE_ICONS + '/' + encodeURIComponent(k) + '.webp',
      file: path.join(ICONS_DIR, k + '.webp')
    })),
    ...names.map((n) => ({
      kind: 'map',
      key: n,
      url: BASE_MAPS + '/' + encodeURIComponent(n) + '.webp',
      file: path.join(MAPS_DIR, n + '.webp')
    }))
  ]

  console.log('К обработке: ' + tasks.length + ' файлов (' +
    ICON_KEYS.length + ' иконок + ' + names.length + ' карт), ' +
    'параллельно до ' + CONCURRENCY + '\n')

  const stats = { downloaded: 0, skipped: 0, missing: 0, bytes: 0 }
  const missing = []
  let done = 0
  const started = Date.now()

  await runPool(tasks, (t, res) => {
    done++
    stats[res.status]++
    stats.bytes += res.bytes || 0
    if (res.status === 'missing') {
      missing.push({ kind: t.kind, key: t.key, url: t.url, reason: res.reason })
      console.log('  ! ' + t.kind + ' ' + t.key + ' — ' + res.reason)
    }
    if (done % PROGRESS_EVERY === 0 || done === tasks.length) {
      console.log('[' + done + '/' + tasks.length + '] скачано ' + stats.downloaded +
        ', пропущено ' + stats.skipped + ', ошибок ' + stats.missing +
        ', ' + mb(stats.bytes))
    }
  })

  // Манифест собираем по фактическому содержимому папок, а не по намерениям
  const onDisk = (dir, kind) => {
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.webp'))
        .filter((f) => alreadyOk(path.join(dir, f), MIN_SIZE[kind]))
        .map((f) => f.slice(0, -5))
        .sort()
    } catch {
      return []
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    maps: onDisk(MAPS_DIR, 'map'),
    icons: onDisk(ICONS_DIR, 'icon'),
    missing: missing.map((m) => m.key)
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log('\n=== Итог (' + secs + ' с) ===')
  console.log('скачано:   ' + stats.downloaded)
  console.log('пропущено: ' + stats.skipped + ' (уже были на диске)')
  console.log('ошибок:    ' + stats.missing)
  console.log('объём:     ' + mb(stats.bytes))
  console.log('на диске:  карт ' + manifest.maps.length + ', иконок ' + manifest.icons.length)
  console.log('манифест:  ' + MANIFEST)
  if (missing.length) {
    console.log('\nНе скачалось (' + missing.length + '):')
    for (const m of missing) console.log('  ' + m.kind + ' ' + m.key + ' — ' + m.reason)
  }
}

main().catch((e) => {
  console.error('Фатальная ошибка:', e)
  process.exit(1)
})
