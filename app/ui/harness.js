// Стенд оформления: рисует показательный кусок графа теми же стилями, что и приложение.
// Данные настоящие — имена зон из zones.json, чтобы длины подписей были честными.
const C = window.ZONE_COLORS;

const nodes = [
  { id: 'Cases-Ugumlos', color: C.avalon, isAvalon: true, here: true },
  { id: 'Casos-Aiagsum', color: C.avalon, isAvalon: true },
  { id: 'Casitos-Alieam', color: C.avalon, isAvalon: true },
  { id: 'Qiient-Et-Nusas', color: C.avalon, isAvalon: true },
  { id: 'Cairn Camain', color: C.black },
  { id: 'Fort Sterling', color: C.city },
  { id: 'Martlock', color: C.city },
  { id: 'Thetford Portal', color: C.blue },
  { id: 'Lymhurst Farmland', color: C.yellow },
  { id: 'Bloodmoss Marsh', color: C.red },
];

const edges = [
  { s: 'Cases-Ugumlos', t: 'Casos-Aiagsum', label: '5 ч 12 м · 7/7' },
  { s: 'Cases-Ugumlos', t: 'Casitos-Alieam', label: '41 м · 7/7' },
  { s: 'Casos-Aiagsum', t: 'Cairn Camain', label: '8 м · 7/7', soon: true },
  { s: 'Casitos-Alieam', t: 'Qiient-Et-Nusas', label: '2 ч 04 м · 7/7' },
  { s: 'Cairn Camain', t: 'Fort Sterling' },
  { s: 'Fort Sterling', t: 'Martlock' },
  { s: 'Qiient-Et-Nusas', t: 'Thetford Portal', label: '3 ч 30 м · 7/7' },
  { s: 'Thetford Portal', t: 'Lymhurst Farmland' },
  { s: 'Lymhurst Farmland', t: 'Bloodmoss Marsh' },
];

const cy = cytoscape({
  container: document.getElementById('cy'),
  wheelSensitivity: 0.2,
  style: window.GRAPH_STYLE,
  elements: [
    ...nodes.map(n => ({ data: { ...n, label: n.id } })),
    ...edges.map(e => ({ data: { id: e.s + '|' + e.t, source: e.s, target: e.t, label: e.label || '', soon: e.soon } })),
  ],
  layout: { name: 'cose', animate: false, nodeRepulsion: 9000, idealEdgeLength: 150, padding: 30 },
});

// показываем подсветку маршрута — это заметная часть оформления
cy.ready(() => {
  const path = ['Cases-Ugumlos', 'Casos-Aiagsum', 'Cairn Camain', 'Fort Sterling'];
  cy.elements().addClass('route-dim');
  path.forEach(id => cy.$id(id).removeClass('route-dim').addClass('route-hit'));
  cy.edges().forEach(e => {
    const a = path.indexOf(e.data('source')), b = path.indexOf(e.data('target'));
    if (a >= 0 && b >= 0 && Math.abs(a - b) === 1) e.removeClass('route-dim').addClass('route-hit');
  });
  cy.fit(undefined, 34);
});
