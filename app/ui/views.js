(() => {
  const toolbar = document.getElementById('graph-tools');
  const cardToggle = document.getElementById('card-toggle');
  function placeCardToggle() {
    const bounds = toolbar.getBoundingClientRect();
    if (bounds.height) cardToggle.style.top = Math.ceil(bounds.bottom + 12) + 'px';
  }
  new ResizeObserver(placeCardToggle).observe(toolbar);
  window.addEventListener('resize', placeCardToggle);
  placeCardToggle();
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
