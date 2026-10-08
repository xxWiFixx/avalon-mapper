import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ast = parse(fs.readFileSync(path.join(root,'src/localization.jsx'),'utf8'), {sourceType:'module',plugins:['jsx']});
const declaration = ast.program.body.find(n => n.type === 'ExportNamedDeclaration' && n.declaration?.declarations?.[0]?.id?.name === 'english');
const messages = Object.fromEntries(declaration.declaration.declarations[0].init.properties.map(p => [p.key.value,p.value.value]));
Object.assign(messages, {
  'Загрузка сайта': 'Loading website', 'Твоя карта Дорог Авалона.': 'Your map of the Roads of Avalon.',
  'Порталы, маршруты, общая карта группы и статистика сессии в Albion Online.': 'Portals, routes, shared group maps and session statistics for Albion Online.',
  'Карта Avalon Mapper': 'Avalon Mapper map', 'Записывай портал по F9': 'Capture portals with F9',
  'Оверлей с картой зоны': 'Zone map overlay', 'Общая карта группы': 'Shared group map',
  'Фейм, урон и DPS': 'Fame, damage and DPS', '799 ₽ / 30 дней': '$8.99 USD / 30 days',
  'Записывай порталы. Находи выход. Исследуй вместе.': 'Capture portals. Find your way out. Explore together.',
});
const escape = value => value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
let html = fs.readFileSync(path.join(root,'../site/index.html'),'utf8');
html = html.replace('<html lang="ru">','<html lang="en">').replace('<head>','<head>\n  <base href="../" />');
html = html.replace(/>([^<>]+)</g,(match,text) => messages[text.trim()] ? '>' + messages[text.trim()] + '<' : match);
html = html.replace(/(content|alt|aria-label)="([^"]+)"/g,(match,attr,value) => messages[value] ? attr+'="'+escape(messages[value])+'"' : match);
html = html.replace('content="ru_RU"','content="en_US"').replaceAll('assets/screens-ai/','assets/screens-en/');
fs.mkdirSync(path.join(root,'../site/en'),{recursive:true});
fs.writeFileSync(path.join(root,'../site/en/index.html'),html);
console.log('Built English entry page: site/en/index.html');
