var i18nText = (globalThis.AvalonI18n?.t || ((text, values) => Array.isArray(values) ? text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match) : text));
// Короткое знакомство при первом запуске. Демонстрационные шаги не меняют карту.
(() => {
  const root = document.getElementById('onboarding');
  const card = root.querySelector('.onboarding-card');
  const welcome = document.getElementById('onboarding-welcome');
  const tour = document.getElementById('onboarding-tour');
  const slides = [...root.querySelectorAll('[data-onboarding-step]')];
  const count = document.getElementById('onboarding-count');
  const progress = document.getElementById('onboarding-progress-fill');
  const back = document.getElementById('onboarding-back');
  const next = document.getElementById('onboarding-next');
  const zoneStatus = document.getElementById('onboarding-zone-status');
  const bindStatus = document.getElementById('onboarding-bind-status');
  const bindButtons = [...root.querySelectorAll('[data-onboarding-bind]')];
  const seenKey = 'avalon-mapper:onboarding:v1';
  const labels = { binding: 'onb-bind-portal', manualBinding: 'onb-bind-manual', searchBinding: 'onb-bind-search', overlayToggleBinding: 'onb-bind-overlay' };
  const settingsLabels = { binding: 'bind-label', manualBinding: 'manual-bind-label', searchBinding: 'search-bind-label', overlayToggleBinding: 'overlay-toggle-bind-label' };
  let step = 0;
  let returnFocus = null;
  let capturing = false;
  let inlineSettings = null;

  function restoreInlineSettings() {
    if (!inlineSettings) return;
    const { section, anchor, slot, button, label, animation } = inlineSettings;
    animation?.cancel();
    slot.style.overflow = '';
    section.hidden = true;
    anchor.parentNode.insertBefore(section, anchor);
    anchor.remove();
    slot.hidden = true;
    card.classList.remove('settings-open');
    button.textContent = label;
    button.setAttribute('aria-expanded', 'false');
    inlineSettings = null;
  }

  function toggleInlineSettings(sectionId, slotId, button, closeLabel) {
    if (inlineSettings?.section.id === sectionId) {
      const current = inlineSettings;
      current.animation?.cancel();
      current.slot.style.overflow = 'hidden';
      button.textContent = current.label;
      button.setAttribute('aria-expanded', 'false');
      const height = current.slot.getBoundingClientRect().height;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) restoreInlineSettings();
      else {
        current.animation = current.slot.animate([
          { height: `${height}px`, opacity: 1 },
          { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px' },
        ], { duration: 250, easing: 'ease-in', fill: 'forwards' });
        current.animation.finished.then(() => { if (inlineSettings === current) restoreInlineSettings(); }).catch(() => {});
      }
      button.focus({ preventScroll: true });
      return;
    }
    restoreInlineSettings();
    const section = document.getElementById(sectionId);
    const slot = document.getElementById(slotId);
    const anchor = document.createComment(i18nText("Вернуть {0} в настройки", [sectionId]));
    section.parentNode.insertBefore(anchor, section);
    slot.appendChild(section);
    section.hidden = false;
    slot.hidden = false;
    card.classList.toggle('settings-open', sectionId === 'set-overlay');
    inlineSettings = { section, anchor, slot, button, label: button.textContent, animation: null };
    button.textContent = closeLabel;
    button.setAttribute('aria-expanded', 'true');
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      slot.style.overflow = 'hidden';
      const height = slot.scrollHeight;
      const current = inlineSettings;
      current.animation = slot.animate([
        { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px' },
        { height: `${height}px`, opacity: 1 },
      ], { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' });
      current.animation.finished.then(() => { if (inlineSettings === current) slot.style.overflow = ''; }).catch(() => {});
    }
  }

  function hasSeen() {
    try { return localStorage.getItem(seenKey) === 'done'; } catch { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(seenKey, 'done'); } catch { /* хранение может быть отключено */ }
    if (ipc && typeof ipc.setOption === 'function') ipc.setOption('onboardingSeen', true).catch(() => {});
  }
  function syncChoices() {
    const selected = cfg && cfg.zoneSource;
    root.querySelectorAll('[data-onboarding-zone]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.onboardingZone === selected));
    });
    document.getElementById('onboarding-screen-region').hidden = selected !== 'screen';
    const region = cfg && cfg.zoneBarRegion;
    document.getElementById('onboarding-region-current').textContent = region
      ? i18nText("Своя область: {0}×{1}", [Math.round(region.width), Math.round(region.height)])
      : i18nText("Стандартная область — под миникартой");
    for (const [target, id] of Object.entries(labels)) {
      const fromSettings = document.getElementById(settingsLabels[target]);
      const fromConfig = cfg && cfg[target] && cfg[target].label;
      document.getElementById(id).textContent = (fromSettings && fromSettings.textContent.trim()) || fromConfig || '—';
    }
    document.getElementById('onb-practice-hotkey').textContent = document.getElementById('onb-bind-portal').textContent;
  }
  function showWelcome() {
    restoreInlineSettings();
    returnFocus = document.activeElement;
    syncChoices();
    zoneStatus.textContent = '';
    root.hidden = false;
    welcome.hidden = false;
    tour.hidden = true;
    card.setAttribute('aria-labelledby', 'onboarding-title');
    document.getElementById('onboarding-start').focus({ preventScroll: true });
  }
  function showStep(index) {
    restoreInlineSettings();
    step = Math.max(0, Math.min(slides.length - 1, index));
    setPracticeActive(step === 3);
    welcome.hidden = true;
    tour.hidden = false;
    slides.forEach((slide, i) => { slide.hidden = i !== step; });
    count.textContent = i18nText("{0} из {1}", [step + 1, slides.length]);
    progress.style.width = `${((step + 1) / slides.length) * 100}%`;
    back.disabled = step === 0;
    next.textContent = step === slides.length - 1 ? i18nText("Готово") : i18nText("Далее");
    card.setAttribute('aria-labelledby', slides[step].querySelector('h2').id);
    card.scrollTop = 0;
    slides[step].querySelector('h2').setAttribute('tabindex', '-1');
    slides[step].querySelector('h2').focus({ preventScroll: true });
  }
  function startTour() {
    if (root.hidden) {
      returnFocus = document.activeElement;
      root.hidden = false;
    }
    syncChoices();
    bindStatus.textContent = i18nText("Нажми на строку, чтобы назначить клавишу.");
    showStep(0);
  }
  function closeTour() {
    if (root.hidden) return;
    restoreInlineSettings();
    setPracticeActive(false);
    markSeen();
    root.hidden = true;
    if (returnFocus && returnFocus.isConnected && !returnFocus.closest('[hidden]')) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }
  document.getElementById('onboarding-start').addEventListener('click', startTour);
  document.getElementById('onboarding-later').addEventListener('click', closeTour);
  document.getElementById('onboarding-close').addEventListener('click', closeTour);
  document.getElementById('onboarding-skip').addEventListener('click', closeTour);
  back.addEventListener('click', () => showStep(step - 1));
  next.addEventListener('click', () => step === slides.length - 1 ? closeTour() : showStep(step + 1));
  document.getElementById('onboarding-replay').addEventListener('click', () => {
    closeModal(document.getElementById('modal-settings'));
    startTour();
  });

  root.querySelectorAll('[data-onboarding-zone]').forEach(button => {
    button.addEventListener('click', async () => {
      const source = button.dataset.onboardingZone;
      if (!ipc || typeof ipc.setOption !== 'function') {
        zoneStatus.textContent = i18nText("Выбор режима доступен в установленном приложении.");
        return;
      }
      button.disabled = true;
      zoneStatus.textContent = i18nText("Сохраняю выбор…");
      try {
        const changed = await ipc.setOption('zoneSource', source);
        applyConfig(changed);
        syncChoices();
        zoneStatus.textContent = changed.zoneError
          ? i18nText("Режим выбран, но пока не работает: ") + changed.zoneError
          : source === 'screen' ? i18nText("Режим с экрана включён. Теперь можно обвести плашку зоны.") : i18nText("Режим из трафика включён.");
        if (source === 'screen') document.getElementById('onboarding-pick-region').focus({ preventScroll: true });
      } catch {
        zoneStatus.textContent = i18nText("Не удалось сохранить режим. Повтори выбор в настройках.");
      } finally { button.disabled = false; }
    });
  });

  document.getElementById('onboarding-pick-region').addEventListener('click', async event => {
    if (!ipc || typeof ipc.pickZoneRegion !== 'function') {
      zoneStatus.textContent = i18nText("Выбор области доступен в установленном приложении.");
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    zoneStatus.textContent = i18nText("Обведи плашку названия зоны под миникартой.");
    try {
      const result = await ipc.pickZoneRegion();
      if (result.cancelled) { zoneStatus.textContent = i18nText("Выбор области отменён."); return; }
      if (!result.ok) { zoneStatus.textContent = i18nText("Не удалось выбрать область: ") + result.error; return; }
      const region = result.region;
      document.getElementById('onboarding-region-current').textContent =
        i18nText("Своя область: {0}×{1}", [Math.round(region.width), Math.round(region.height)]);
      document.getElementById('zone-region').textContent =
        i18nText("Своя область: {0}×{1} в точке {2}, {3}", [Math.round(region.width), Math.round(region.height), Math.round(region.left), Math.round(region.top)]);
      zoneStatus.textContent = result.zone
        ? i18nText("Область сохранена. Вижу зону «{0}».", [result.zone])
        : i18nText("Область сохранена, но название зоны пока не прочиталось.");
    } catch {
      zoneStatus.textContent = i18nText("Не удалось сохранить область. Попробуй ещё раз.");
    } finally { button.disabled = false; }
  });

  bindButtons.forEach(button => button.addEventListener('click', async () => {
    if (capturing) return;
    if (!ipc || typeof ipc.captureBinding !== 'function') {
      bindStatus.textContent = i18nText("Назначение клавиш доступно в установленном приложении.");
      return;
    }
    capturing = true;
    bindButtons.forEach(item => { item.disabled = true; });
    button.setAttribute('aria-busy', 'true');
    bindStatus.textContent = i18nText("Нажми клавишу или боковую кнопку мыши. Esc — отмена.");
    try {
      const label = await ipc.captureBinding(button.dataset.onboardingBind);
      setBindingLabel(button.dataset.onboardingBind, label);
      document.getElementById(labels[button.dataset.onboardingBind]).textContent = label;
      if (button.dataset.onboardingBind === 'binding') document.getElementById('onb-practice-hotkey').textContent = label;
      bindStatus.textContent = i18nText("Клавиша сохранена.");
    } catch {
      bindStatus.textContent = i18nText("Не удалось назначить клавишу. Попробуй ещё раз.");
    } finally {
      capturing = false;
      bindButtons.forEach(item => { item.disabled = false; });
      button.removeAttribute('aria-busy');
    }
  }));

  document.getElementById('onboarding-overlay-settings').addEventListener('click', event =>
    toggleInlineSettings('set-overlay', 'onboarding-overlay-panel', event.currentTarget, i18nText("Скрыть настройки оверлея")));
  document.getElementById('onboarding-data-settings').addEventListener('click', event =>
    toggleInlineSettings('set-maps', 'onboarding-data-panel', event.currentTarget, i18nText("Скрыть настройки карт")));

  // Тренировка использует глобальную клавишу приложения, но main перехватывает её
  // до захвата экрана. Сама плашка появляется в настоящем окне оверлея.
  const practiceScene = document.getElementById('onboarding-practice-scene');
  const practiceTooltip = document.getElementById('onboarding-practice-tooltip');
  const practiceStatus = document.getElementById('onboarding-practice-status');
  const practiceNames = ['Spindlewood', 'Quaent-In-Nusis', 'Puros-Amayam'];
  const practiceDurations = [4 * 3600 + 18 * 60 + 40, 1 * 3600 + 56 * 60 + 40, 9 * 3600 + 38 * 60 + 40];
  let practiceDeadlines = [];
  let practiceClock = null;
  let hoveredPortal = -1;
  let practiceEnabled = false;
  function setPracticeActive(active) {
    practiceEnabled = active;
    clearInterval(practiceClock);
    practiceClock = null;
    if (active) {
      practiceDeadlines = practiceDurations.map(seconds => Date.now() + seconds * 1000);
      practiceClock = setInterval(() => {
        if (hoveredPortal >= 0 && !practiceTooltip.hidden)
          document.getElementById('onboarding-tooltip-time').textContent = practiceTime(hoveredPortal);
      }, 1000);
    }
    if (ipc && typeof ipc.onboardingPractice === 'function') ipc.onboardingPractice(active).catch(() => {});
    if (!active) {
      hoveredPortal = -1;
      practiceTooltip.hidden = true;
    }
  }
  function practiceSeconds(index) { return Math.max(0, Math.floor((practiceDeadlines[index] - Date.now()) / 1000)); }
  function practiceTime(index) {
    const sec = practiceSeconds(index);
    return i18nText("{0} ч {1} м", [Math.floor(sec / 3600), String(Math.floor(sec % 3600 / 60)).padStart(2, '0')]);
  }
  function placePracticeTooltip(event, index) {
    const bounds = practiceScene.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    practiceTooltip.dataset.portal = String(index);
    document.getElementById('onboarding-tooltip-name').textContent = practiceNames[index];
    document.getElementById('onboarding-tooltip-time').textContent = practiceTime(index);
    practiceTooltip.style.left = `${Math.max(3, Math.min(bounds.width - 293, x + 17))}px`;
    practiceTooltip.style.top = `${Math.max(3, Math.min(bounds.height - 94, y - 100))}px`;
    practiceTooltip.hidden = false;
  }
  practiceScene.querySelectorAll('[data-portal]').forEach(portal => {
    const index = Number(portal.dataset.portal);
    portal.addEventListener('pointerenter', event => {
      hoveredPortal = index;
      placePracticeTooltip(event, index);
      practiceStatus.textContent = i18nText("Портал в {0}. Нажми {1}.", [practiceNames[index], document.getElementById('onb-practice-hotkey').textContent]);
    });
    portal.addEventListener('pointermove', event => placePracticeTooltip(event, index));
    portal.addEventListener('pointerleave', () => { hoveredPortal = -1; practiceTooltip.hidden = true; });
    portal.addEventListener('focus', () => {
      hoveredPortal = index;
      const bounds = portal.getBoundingClientRect();
      placePracticeTooltip({ clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }, index);
    });
    portal.addEventListener('blur', () => { hoveredPortal = -1; practiceTooltip.hidden = true; });
  });
  async function triggerPractice() {
    if (!practiceEnabled || root.hidden) return;
    if (hoveredPortal < 0) {
      practiceStatus.textContent = i18nText("Сначала наведи курсор на голубой портал, затем нажми горячую клавишу.");
      return;
    }
    const index = hoveredPortal;
    const name = practiceNames[index];
    if (!ipc || typeof ipc.onboardingPracticeShow !== 'function') {
      practiceStatus.textContent = i18nText("Пробный оверлей можно увидеть в установленном приложении.");
      return;
    }
    const result = await ipc.onboardingPracticeShow(index, practiceDeadlines[index]);
    practiceStatus.textContent = result?.ok
      ? i18nText("Плашка {0} показана в выбранном месте. Карта не изменена.", [name])
      : i18nText("Плашка не показана: {0}.", [result?.reason || i18nText("попробуй ещё раз")]);
  }
  if (ipc && typeof ipc.on === 'function') ipc.on('onboarding-practice-hotkey', triggerPractice);
  document.addEventListener('keydown', event => {
    if (ipc && typeof ipc.onboardingPractice === 'function') return;
    if (event.key.toUpperCase() === document.getElementById('onb-practice-hotkey').textContent.toUpperCase()) triggerPractice();
  });
  // Пять учебных цепочек, включая Авалон в середине и в качестве цели.
  // Вместимость и время условные; это демонстрация оформления, а не живые порталы.
  // Цвет и тир взяты из тех же royal-zones / zone-data, что и у основной карты.
  const demoRoutes = [
    { names: ['Martlock', 'Eldon Hill', 'Bowscale Fell', 'Hynos-Oiaelos', 'Casitos-Avaelum'], types: ['city:1', 'yellow:5', 'red:6', 'avalon:6', 'avalon:6'], points: [[70,55],[175,110],[304,42],[438,104],[565,105]] },
    { names: ['Lymhurst', 'Yew Wood', 'Owlsong Glen', 'Cynos-Avixnum', 'Fynites-Aeaosum'], types: ['city:1', 'yellow:5', 'red:6', 'avalon:6', 'avalon:4'], points: [[62,92],[166,48],[295,113],[426,14],[567,120]] },
    { names: ['Bridgewatch', 'Lazygrass Plain', 'Kindlegrass Steppe', 'Oures-Araosum', 'Domhain Chasm'], types: ['city:1', 'yellow:5', 'red:6', 'avalon:6', 'red:7'], points: [[72,45],[194,100],[316,49],[465,110],[570,12]] },
    { names: ['Fort Sterling', 'Cairn Camain', 'Turitos-Uoemtum', 'Redstone Plain'], types: ['city:1', 'yellow:5', 'avalon:4', 'yellow:5'], points: [[72,65],[228,116],[400,46],[566,103]] },
    { names: ['Thetford', 'Willowsigh Marsh', 'Ouyos-Aoeuam', 'Secent-Viesum'], types: ['city:1', 'yellow:5', 'avalon:4', 'avalon:6'], points: [[75,105],[215,48],[399,112],[564,52]] },
  ];
  const routeDestination = document.getElementById('onboarding-route-destination');
  const routeGraphic = document.getElementById('onboarding-route-graphic');
  const routeResult = document.getElementById('onboarding-route-result');
  const routePlaceholder = document.getElementById('onboarding-route-placeholder');
  let routeGraph = null;
  let routeTimers = [];
  function clearRouteDemo() {
    routeTimers.forEach(clearTimeout);
    routeTimers = [];
    if (routeGraph) { routeGraph.destroy(); routeGraph = null; }
    routePlaceholder.hidden = false;
  }
  routeDestination.addEventListener('change', () => {
    clearRouteDemo();
    routeResult.textContent = i18nText("Нажми «Найти маршрут», чтобы увидеть пример на схеме.");
  });
  document.getElementById('onboarding-route-city').addEventListener('click', () => {
    clearRouteDemo();
    const route = demoRoutes[Number(routeDestination.value)];
    routePlaceholder.hidden = true;
    routeGraph = cytoscape({
      container: routeGraphic, style: [...window.graphStyle(),
        { selector: 'node.onboarding-demo', style: { 'z-index': 30 } },
        { selector: 'node.onboarding-ghost', style: {
          label: '', 'background-opacity': 0, 'border-opacity': 0, 'text-opacity': 0,
        } },
        { selector: 'edge.route-demo', style: { 'text-background-padding': 1.5 } },
      ], elements: [],
      layout: { name: 'preset' }, userZoomingEnabled: false, userPanningEnabled: false,
      boxSelectionEnabled: false, autoungrabify: false,
      pixelRatio: Math.max(2, window.devicePixelRatio || 1),
    });
    const graph = routeGraph;
    graph.on('drag', 'node', () => graph.edges().addClass('drag-lite'));
    graph.on('free', 'node', () => graph.edges().removeClass('drag-lite'));
    const scale = Math.min(1, (routeGraphic.clientWidth - 40) / 640);
    const offsetX = (routeGraphic.clientWidth - 640 * scale) / 2;
    const offsetY = Math.max(12, (routeGraphic.clientHeight - 160 * scale) / 2);
    route.names.forEach((name, i) => {
      routeTimers.push(setTimeout(() => {
        if (routeGraph !== graph) return;
        const [kind, tierText] = route.types[i].split(':');
        const tier = Number(tierText);
        const id = `demo-${i}`;
        const node = graph.add({ group: 'nodes', data: {
          id, label: name, color: window.ZONE_COLORS[kind],
          isAvalon: kind === 'avalon', tier,
          tierIcon: kind === 'city' ? undefined : window.tierBadge(tier),
        }, position: { x: offsetX + route.points[i][0] * scale, y: offsetY + route.points[i][1] * scale },
        classes: 'onboarding-demo' });
        node.style('opacity', 0);
        node.animate({ style: { opacity: 1 } }, { duration: 270, easing: 'ease-out' });
        if (i > 0) {
          const priorAvalon = route.types[i - 1].startsWith('avalon');
          const portal = priorAvalon || kind === 'avalon';
          const [fromX, fromY] = route.points[i - 1];
          const [toX, toY] = route.points[i];
          const x1 = offsetX + fromX * scale, y1 = offsetY + fromY * scale;
          const x2 = offsetX + toX * scale, y2 = offsetY + toY * scale;
          // Временное ребро растёт в Cytoscape, поэтому остаётся под точками и
          // во время анимации, и после появления окончательной линии.
          const ghostId = `demo-ghost-${i}`;
          const ghost = graph.add({ group: 'nodes', data: { id: ghostId },
            position: { x: x1, y: y1 }, classes: 'onboarding-ghost',
            grabbable: false, selectable: false });
          ghost.style({ width: kind === 'avalon' ? 29 : 24,
            height: kind === 'avalon' ? 29 : 24, shape: kind === 'avalon' ? 'diamond' : 'ellipse' });
          graph.add({ group: 'edges', data: {
            id: `demo-drawing-${i}`, source: `demo-${i - 1}`, target: ghostId, label: '',
          }, classes: 'route-hit route-demo' });
          ghost.animate({ position: { x: x2, y: y2 } }, { duration: 300, easing: 'ease-out', complete: () => {
            if (routeGraph !== graph) return;
            graph.getElementById(`demo-drawing-${i}`).remove();
            ghost.remove();
            graph.add({ group: 'edges', data: {
              id: `demo-edge-${i}`, source: `demo-${i - 1}`, target: id,
              label: portal ? i18nText("на 7 · {0}ч {1}м", [i + 2, 18 + i * 7]) : '',
            }, classes: 'route-hit route-demo' });
          } });
        }
      }, i * 320));
    });
    routeResult.textContent = i18nText("Учебный маршрут из любого города: {0}.", [route.names.join(' → ')]);
  });

  // Перетащить можно только пример; фактическое положение задаётся в настройках.
  const demo = document.getElementById('onboarding-overlay-demo');
  const sample = document.getElementById('onboarding-overlay-sample');
  const sampleRoot = sample.attachShadow({ mode: 'open' });
  sampleRoot.innerHTML = `<link rel="stylesheet" href="overlay.css">
    <style>:host { display:block; width:290px; height:140px; } .preview-stage { height:140px; display:flex; flex-direction:column; align-items:flex-end; justify-content:flex-end; font:400 12px/1.4 'Fira Sans','Segoe UI',sans-serif; font-variant-numeric:tabular-nums; color:#ece0c8; } #box { flex:none; }</style>
    <div class="preview-stage"><div id="box" hidden><div class="ov-map"><img id="ovMap" alt=""></div><div class="ov-scroll"><span class="sc-tier" id="ovTier"></span><span class="sc-mark" id="ovMark"></span><span class="sc-name" id="ovName"></span><span class="sc-time" id="ovTime"></span></div><div class="ov-panel" id="ovPanel"></div></div><div id="ovGuide" hidden></div></div>`;
  const sampleRenderer = window.createOverlayRenderer(sampleRoot, null);
  (async () => {
    let info = null;
    try {
      if (ipc?.getZoneInfo) info = await ipc.getZoneInfo('Xiros-Aiairom');
      else {
        const zones = await (await fetch('../data-static/zone-data.json')).json();
        const activities = zones.find(zone => zone.name === 'Xiros-Aiairom');
        if (activities) info = { color: 'avalon', tier: activities.tier, activities };
      }
    } catch { /* предпросмотр возможен и без справочника */ }
    sampleRenderer.show({
      showMap: false,
      tip: { name: 'Xiros-Aiairom', color: info?.color || 'avalon', tier: info?.tier || 6,
        activities: info?.activities || null, capNum: 7, capMax: 20, capMaxKnown: true, closes: 4920 },
    });
  })();
  let drag = null;
  sample.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const box = demo.getBoundingClientRect();
    const item = sample.getBoundingClientRect();
    drag = { dx: event.clientX - item.left, dy: event.clientY - item.top };
    sample.style.left = `${item.left - box.left}px`;
    sample.style.top = `${item.top - box.top}px`;
    sample.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  sample.addEventListener('pointermove', event => {
    if (!drag) return;
    const box = demo.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width - sample.offsetWidth, event.clientX - box.left - drag.dx));
    const y = Math.max(0, Math.min(box.height - sample.offsetHeight, event.clientY - box.top - drag.dy));
    sample.style.left = `${x}px`;
    sample.style.top = `${y}px`;
  });
  sample.addEventListener('pointerup', () => { drag = null; });
  sample.addEventListener('pointercancel', () => { drag = null; });

  document.addEventListener('keydown', event => {
    if (root.hidden) return;
    if (event.key === 'Escape') {
      // Во время назначения Escape отменяет захват горячей клавиши.
      event.stopImmediatePropagation();
      if (!capturing) { event.preventDefault(); closeTour(); }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll('button:not([disabled]):not([hidden]), [tabindex="0"]')]
      .filter(el => !el.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, true);

  const splash = document.getElementById('app-splash');
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const params = new URLSearchParams(location.search);
  function finishSplash() {
    if (!splash || splash.hidden) return;
    splash.hidden = true;
    if (params.get('onboarding') === 'tour') startTour();
    else if (params.get('onboarding') === 'welcome') showWelcome();
    else if (ipc && !hasSeen()) ipc.getConfig()
      .then(current => { if (!cfg) applyConfig(current); if (!current.onboardingSeen) showWelcome(); })
      .catch(showWelcome);
  }
  if (splash) {
    let startedSplash = false;
    const startSplash = async () => {
      if (startedSplash) return;
      startedSplash = true;
      const logo = splash.querySelector('img');
      await Promise.allSettled([document.fonts.ready, logo?.decode?.()]);
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      splash.classList.add('playing');
      window.setTimeout(() => {
      if (reducedMotion) return finishSplash();
      splash.classList.add('leaving');
      window.setTimeout(finishSplash, 300);
      }, reducedMotion ? 80 : 1850);
    };
    if (ipc && typeof ipc.on === 'function') ipc.on('splash-start', () => {
      if (window.__mapperMapReady) startSplash();
      else {
        window.addEventListener('mapper-map-ready', startSplash, { once: true });
        window.setTimeout(startSplash, 1000);
      }
    });
    else window.requestAnimationFrame(() => window.requestAnimationFrame(startSplash));
  }
})();
