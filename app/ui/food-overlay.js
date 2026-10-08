'use strict';
(() => {
  const tr = globalThis.AvalonI18n?.t || (text => text);
  const title = document.querySelector('.food-copy strong');
  const detail = document.getElementById('food-detail');
  function render(state) {
    const food = state?.foodBuff;
    if (!food?.warning) return;
    if (food.alert === 'missing') {
      title.textContent = tr('Ты не поел');
      detail.textContent = tr('Баффа еды нет');
      return;
    }
    title.textContent = tr('Еда скоро закончится');
    const minutes = Math.max(0, Math.ceil(food.remainingMs / 60000));
    detail.textContent = food.remainingMs < 60000 ? tr('Осталось меньше минуты') : tr('Осталось около {0} мин', [minutes]);
  }
  window.api?.on('metrics-updated', render);
  window.api?.getMetrics().then(render).catch(() => {});
})();
