// Keep the web map tied to the application's actual styles and algorithms.
// Only environment adapters are changed; app/** is always read-only here.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => fs.readFileSync(path.join(root, 'app', name), 'utf8').replace(/\r\n/g, '\n');
const write = (name, source) => {
  const file = path.join(root, 'site-source/src/cloud/generated', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) fs.writeFileSync(file, source);
};
function replace(source, pattern, replacement) {
  if (!pattern.test(source)) throw new Error(`App interface adapter no longer matches: ${pattern}`);
  return source.replace(pattern, replacement);
}

export function syncAppInterface() {
  const css = postcss.parse(read('ui/style.css') + '\n' + read('ui/controls.css'));
  css.walkAtRules('import', rule => rule.remove());
  // Prefix animation names too: loading this CSS must not affect the landing page.
  const animations = [];
  css.walkAtRules('keyframes', rule => { animations.push(rule.params); rule.params = 'mapper-' + rule.params; });
  css.walkDecls(/animation/, decl => {
    for (const name of animations) decl.value = decl.value.replace(new RegExp(`\\b${name}\\b`, 'g'), 'mapper-' + name);
  });
  css.walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    rule.selectors = rule.selectors.map(selector => {
      const scoped = selector.replace(/:root|\bhtml\b|\bbody(?:\.mapper-app)?\b/g, '.mapper-web');
      return scoped.startsWith('.mapper-web') ? scoped : '.mapper-web ' + scoped;
    });
  });
  css.walkComments(comment => comment.remove());
  write('app-interface.css', '/* Generated from app/ui/style.css and controls.css. Run Vite to update. */\n' + css.toString());

  let graph = read('ui/graph-style.js');
  graph = replace(graph, /getComputedStyle\(document\.documentElement\)/, "getComputedStyle(document.querySelector('.mapper-web') || document.documentElement)");
  graph = replace(graph, /window\.GRAPH_STYLE = window\.graphStyle\(\);/, '');
  write('graph-style.js', '// Generated from app/ui/graph-style.js.\n' + graph);

  let router = read('lib/router.js');
  router = replace(router, /const i18nText = require\("\.\/i18n"\)\.t;/, 'export function createRouter(zoneRecords, worldAdjacency, i18nText) {');
  router = replace(router, /const fs = require\('fs'\);[\s\S]*?const WORLD_ADJACENCY_PATH = [^;]+;/, "const WORLD_ADJACENCY_PATH = 'assets/map/world-adjacency.json';");
  router = replace(router, /let zoneInfoCache = null;[\s\S]*?\n\/\/ Функция/, 'function getZoneInfo() { return new Map(Object.entries(zoneRecords)); }\n\n// Функция');
  router = replace(router, /function loadWorldAdjacency\(opts = \{\}\) \{[\s\S]*?\n\}\n\n\/\/ ---------- построение/, "function loadWorldAdjacency() {\n  const zones = normalizeAdjacency(worldAdjacency);\n  return { zones, ok: zones.size > 0, error: zones.size ? null : i18nText('Смежность мира недоступна'), path: WORLD_ADJACENCY_PATH };\n}\n\n// ---------- построение");
  router = replace(router, /module\.exports = \{/, 'return {');
  write('router.js', '// Generated from app/lib/router.js; the search and timer rules are unchanged.\n' + router + '\n}\n');

  let activities = read('ui/activities.js');
  activities = replace(activities, /^var i18nText = [^\n]+\n/, 'export function createZoneActivities(i18nText) {\n');
  activities = replace(activities, /\(function \(root\) \{/, 'const root = {};');
  activities = replace(activities, /\}\)\(typeof window[^\n]+/, 'return root.ZONE_ACTS;\n}');
  write('activities.js', '// Generated from app/ui/activities.js.\n' + activities);

  const catalogue = read('locales/en.js');
  const start = catalogue.indexOf('{', catalogue.indexOf('const messages ='));
  const end = catalogue.lastIndexOf('};');
  const messages = Function('return (' + catalogue.slice(start, end + 1) + ')')();
  // Only bring in strings used by these shared modules.
  const used = [...(read('lib/router.js') + read('ui/activities.js')).matchAll(/i18nText\("((?:[^"\\]|\\.)*)"/g)].map(match => JSON.parse('"' + match[1] + '"'));
  write('messages.js', 'export const appEnglish = ' + JSON.stringify(Object.fromEntries(used.filter(key => messages[key]).map(key => [key, messages[key]])), null, 2) + ';\n');
}
