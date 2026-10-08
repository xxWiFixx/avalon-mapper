'use strict';
window.api = { on: () => () => {} };
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.type !== 'onboarding-overlay-show') return;
  if (typeof window.__overlayShow === 'function') window.__overlayShow(event.data.payload);
});
