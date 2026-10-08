(() => {
  const graph = document.getElementById('graph');
  const route = document.getElementById('route-block');
  const toolbar = document.getElementById('graph-tools');
  // Only inspector clearance changes: never resize or reposition graph nodes.
  const measurePanels = () => {
    if (route.offsetHeight) graph.style.setProperty('--route-panel-height', route.offsetHeight + 'px');
    if (toolbar.offsetHeight) graph.style.setProperty('--workspace-toolbar-height', toolbar.offsetHeight + 'px');
  };
  new ResizeObserver(measurePanels).observe(route);
  new ResizeObserver(measurePanels).observe(toolbar);
  measurePanels();
  const placements = [...document.querySelectorAll('[data-route-position]')];
  const positions = new Set(['bottom', 'left', 'right']);
  let savedPlacement = 'bottom';
  try { savedPlacement = localStorage.getItem('route-placement') || 'bottom'; } catch {}
  if (!positions.has(savedPlacement)) savedPlacement = 'bottom';
  function setPlacement(next) {
    if (!positions.has(next)) next = 'bottom';
    document.body.dataset.routePlacement = next;
    for (const button of placements) button.setAttribute('aria-pressed', String(button.dataset.routePosition === next));
    try { localStorage.setItem('route-placement', next); } catch {}
    measurePanels();
  }
  setPlacement(savedPlacement);
  for (const button of placements) button.addEventListener('click', () => setPlacement(button.dataset.routePosition));
  const tabs = ['map', 'damage'];
  function select(name) {
    document.body.dataset.view = name;
    document.getElementById('cy').hidden = name !== 'map';
    document.getElementById('damage-panel').hidden = name !== 'damage';
    for (const n of tabs) {
      const tab = document.getElementById('tab-' + n), active = name === n;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    window.dispatchEvent(new Event('resize'));
  }
  for (const n of tabs) {
    const tab = document.getElementById('tab-' + n);
    tab.addEventListener('click', () => select(n));
    tab.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 'map' : e.key === 'End' ? 'damage' : tabs.find(v => v !== n);
      select(next); document.getElementById('tab-' + next).focus();
    });
  }
})();
