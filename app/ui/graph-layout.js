// Раскладка графа — то, что делает её ОДИНАКОВОЙ У ВСЕХ.
//
// Зачем: игроки сравнивают карты между собой («у меня так, у тебя иначе»), а cose
// раскладывал граф двумя способами, зависящими от машины:
//   1) стартовые позиции брал из Math.random — у каждого свой рисунок;
//   2) разброс мерил по РАЗМЕРУ ОКНА (cy.width/height, когда boundingBox не задан) —
//      на ноутбуке и на 4К выходило разное даже при одинаковом наборе порталов.
// Плюс третье, видимое одному игроку: переключение канала раскладывало заново, и
// «Все карты» с «Друзьями» выглядели по-разному, хотя порталы в них те же самые.
//
// Здесь оба источника расхождения убраны. Файл общий для страницы и для node —
// как ui/search-line.js: раскладку надо проверять тестом, а не глазами.
(function (root) {
  // Генератор со сменным зерном (mulberry32): короткий, без зависимостей и с ровным
  // распределением. Криптостойкость тут не нужна — нужна повторяемость.
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Отпечаток состава графа.
  //
  // Имена зон и пары СОРТИРУЮТСЯ, и это главное в функции: порядок, в котором порталы
  // попали в карту, у игроков разный — кто что раньше отсканировал, что раньше приехало
  // с сервера. Рисунок обязан зависеть только от того, ЧТО в графе, а не от того, когда
  // оно туда попало, иначе одинаковые карты снова разъедутся.
  // Пара зон тоже сортируется: портал ненаправленный, и «A→B» у одного и «B→A» у другого
  // — это одно и то же ребро.
  function seedFrom(nodeIds, edgePairs) {
    const parts = Array.from(nodeIds).map(String).sort()
      .concat(Array.from(edgePairs).map(p => [String(p[0]), String(p[1])].sort().join('|')).sort());
    const s = parts.join(',');
    let h = 0x811c9dc5;                       // FNV-1a
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); }
    return h >>> 0;
  }

  // Поле раскладки — от числа узлов, а не от окна. Плотность подобрана так, чтобы на
  // старте узлы стояли примерно в длину ребра друг от друга: реже — граф расползается
  // и cose тратит итерации на стягивание, плотнее — стартует комком.
  function boxSide(nodeCount, linkLen) {
    return Math.max(800, Math.round(Math.sqrt(Math.max(1, nodeCount)) * linkLen * 1.6));
  }

  // Настройки cose одним местом: их читает и страница, и тест. Разъедутся — тест
  // перестанет проверять то, что происходит на самом деле.
  function options(nodeCount, linkLen) {
    const side = boxSide(nodeCount, linkLen);
    return {
      name: 'cose', animate: false, fit: false, padding: 60, randomize: true,
      boundingBox: { x1: 0, y1: 0, w: side, h: side },
      idealEdgeLength: linkLen, edgeElasticity: 60, nodeRepulsion: 20000,
      nodeOverlap: 40, componentSpacing: 220, gravity: 0.3, numIter: 1200,
    };
  }

  // ПОРЯДОК ЭЛЕМЕНТОВ — вторая половина повторяемости, и без неё зерно бесполезно.
  //
  // cose обходит узлы в том порядке, в каком они лежат в коллекции, и складывает силы
  // по очереди; сложение чисел с плавающей точкой не коммутативно, поэтому другой
  // порядок даёт другой результат даже при том же зерне. А порядок у игроков РАЗНЫЙ:
  // граф наполняется по мере того, кто что отсканировал и что раньше приехало с сервера.
  // Поэтому перед раскладкой пересобираем коллекцию в канонический порядок: узлы по
  // имени зоны, рёбра по отсортированной паре зон.
  function sortedEles(cy) {
    const key = ele => (ele.isNode()
      ? 'n:' + ele.id()
      : 'e:' + [ele.data('source'), ele.data('target')].sort().join('|'));
    return cy.elements().sort((a, b) => {
      const ka = key(a), kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  // ТРЕТИЙ источник расхождения, и самый неочевидный: ПРЕЖНИЕ ПОЗИЦИИ УЗЛОВ.
  //
  // Казалось бы, при randomize:true они ни при чём — cose раскидывает узлы заново. Но
  // замер на живой странице говорит обратное: та же коллекция, то же зерно, тот же
  // порядок — и разные результаты, если перед раскладкой узлы стояли по-разному.
  // Стоит привести их к одному виду, и два прогона совпадают до третьего знака.
  // (Что именно cose уносит из прежнего состояния — неважно; важно, что уносит.)
  //
  // Для игроков это ровно тот случай: граф у каждого рос в своём порядке, узлы стоят
  // где попало, и «одинаковый набор порталов» давал разный рисунок. Поэтому перед
  // полной раскладкой ставим узлы на сетку по алфавиту — состояние, которое у всех одно.
  function resetPositions(cy, side) {
    const ids = cy.nodes().map(n => n.id()).sort();
    const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    const step = side / cols;
    cy.batch(() => {
      ids.forEach((id, i) => {
        cy.$id(id).position({ x: (i % cols) * step, y: Math.floor(i / cols) * step });
      });
    });
  }

  // Прокрутить раскладку с засеянной случайностью и вернуть Math.random как было.
  //
  // Подмена глобального Math.random безопасна ровно потому, что cose с animate:false
  // прокручивает весь цикл ВНУТРИ run() и оттуда же синхронно шлёт layoutstop (ветка
  // `else` в CoseLayout.prototype.run) — до finally никто другой выполниться не успеет.
  // С animate:true так делать было бы нельзя, и поэтому animate зашит здесь же, в options.
  function runSeeded(layout, seed) {
    const real = Math.random;
    Math.random = mulberry32(seed);
    try { layout.run(); } finally { Math.random = real; }
  }

  // Conservative model-space bounds include the node, wrapped name and timer pill.
  const validPosition = p => p && Number.isFinite(p.x) && Number.isFinite(p.y)
    && Math.abs(p.x) <= 1e6 && Math.abs(p.y) <= 1e6;
  const nodeBox = p => ({ l: p.x - 55, r: p.x + 55, t: p.y - 23, b: p.y + 57 });
  const pillBox = (a, b) => ({ l: (a.x + b.x) / 2 - 48, r: (a.x + b.x) / 2 + 48,
    t: (a.y + b.y) / 2 - 10, b: (a.y + b.y) / 2 + 10 });
  const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  function crosses(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return side(a, b, c) * side(a, b, d) < -0.01 && side(c, d, a) * side(c, d, b) < -0.01;
  }
  function hitsBox(a, b, r) {
    let lo = 0, hi = 1;
    for (const [start, delta, min, max] of [[a.x, b.x - a.x, r.l, r.r], [a.y, b.y - a.y, r.t, r.b]]) {
      if (Math.abs(delta) < 1e-9) { if (start < min || start > max) return false; }
      else {
        const u = (min - start) / delta, v = (max - start) / delta;
        lo = Math.max(lo, Math.min(u, v)); hi = Math.min(hi, Math.max(u, v));
        if (lo > hi) return false;
      }
    }
    return true;
  }

  // Only missing positions are computed. No springs, randomness or viewport inputs.
  // Callers persist the returned positions; timers and extra links never move a node.
  function incremental(nodeIds, edgePairs, saved = {}, linkLen = 180) {
    const ids = [...new Set(nodeIds)].map(String).sort();
    const positions = Object.create(null), neighbors = new Map(ids.map(id => [id, []]));
    const pairs = [...new Map(edgePairs.map(pair => {
      const p = pair.map(String).sort(); return [JSON.stringify(p), p];
    })).values()].filter(([a, b]) => a !== b && neighbors.has(a) && neighbors.has(b))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
    for (const [a, b] of pairs) { neighbors.get(a).push(b); neighbors.get(b).push(a); }
    for (const id of ids) if (Object.hasOwn(saved, id) && validPosition(saved[id])) positions[id] = { x: saved[id].x, y: saved[id].y };
    const pending = new Set(ids.filter(id => !positions[id]));
    while (pending.size) {
      // Finish connected branches before starting a disconnected component.
      const id = [...pending].find(n => neighbors.get(n).some(a => positions[a])) || pending.values().next().value;
      const anchors = neighbors.get(id).filter(a => positions[a]);
      const occupied = Object.entries(positions).map(([name, p]) => ({ name, p, box: nodeBox(p) }));
      const segments = pairs.filter(([a, b]) => positions[a] && positions[b])
        .map(([a, b]) => ({ a, b, p: positions[a], q: positions[b], pill: pillBox(positions[a], positions[b]) }));
      if (!anchors.length) {
        positions[id] = { x: occupied.length ? Math.max(...occupied.map(n => n.p.x)) + linkLen * 2 : 0, y: 0 };
        pending.delete(id); continue;
      }
      const center = anchors.reduce((p, a) => ({ x: p.x + positions[a].x / anchors.length,
        y: p.y + positions[a].y / anchors.length }), { x: 0, y: 0 });
      const origins = [...new Map([center, ...anchors.slice(0, 3).map(a => positions[a])]
        .map(p => [p.x + ':' + p.y, p])).values()];
      const phase = seedFrom([id], []) / 4294967296 * Math.PI * 2;
      let best = null, bestScore = Infinity;
      function score(p) {
        const box = nodeBox(p), links = anchors.map(a => ({ a, p: positions[a], pill: pillBox(p, positions[a]) }));
        let cost = 0;
        for (const n of occupied) {
          const distance = Math.hypot(p.x - n.p.x, p.y - n.p.y);
          if (overlap(box, n.box)) cost += 1e6;
          if (distance < 125) cost += (125 - distance) * 10000;
          for (const link of links) {
            if (n.name !== link.a && hitsBox(p, link.p, n.box)) cost += 60000;
            if (overlap(link.pill, n.box)) cost += 20000;
          }
        }
        for (const edge of segments) {
          if (hitsBox(edge.p, edge.q, box)) cost += 60000;
          if (overlap(box, edge.pill)) cost += 20000;
          for (const link of links) {
            if (edge.a !== link.a && edge.b !== link.a && crosses(p, link.p, edge.p, edge.q)) cost += 12000;
            if (overlap(link.pill, edge.pill)) cost += 10000;
          }
        }
        for (let i = 0; i < links.length; i++) {
          const link = links[i], distance = Math.hypot(p.x - link.p.x, p.y - link.p.y);
          cost += Math.abs(distance - linkLen) * 2;
          if (overlap(box, link.pill)) cost += 20000;
          for (let j = i + 1; j < links.length; j++) if (overlap(link.pill, links[j].pill)) cost += 10000;
        }
        return cost;
      }
      for (const origin of origins) for (const radius of [1, 1.4, 2, 2.8]) for (let k = 0; k < 24; k++) {
        const angle = phase + k * Math.PI / 12;
        const p = { x: origin.x + Math.cos(angle) * linkLen * radius, y: origin.y + Math.sin(angle) * linkLen * radius };
        const cost = score(p);
        if (cost < bestScore) { bestScore = cost; best = p; }
      }
      positions[id] = { x: Math.round(best.x * 100) / 100, y: Math.round(best.y * 100) / 100 };
      pending.delete(id);
    }
    return positions;
  }

  root.GRAPH_LAYOUT = { mulberry32, seedFrom, boxSide, options, runSeeded, sortedEles, resetPositions,
    incremental, validPosition, nodeBox, pillBox, overlap, crosses, hitsBox };
})(typeof window !== 'undefined' ? window : globalThis);
