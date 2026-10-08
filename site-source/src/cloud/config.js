export const DEFAULT_CLOUD = Object.freeze({
  url: 'https://qmcnvhufsadnkudtymjc.supabase.co',
  key: 'sb_publishable_S2iVb80RoMu6lgwm3xMS6w_zmG3DMH_',
});

export function cloudConfig(environment = {}) {
  const url = String(environment.VITE_SUPABASE_URL || DEFAULT_CLOUD.url).replace(/\/+$/, '');
  const key = String(environment.VITE_SUPABASE_PUBLISHABLE_KEY || DEFAULT_CLOUD.key);
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url)) throw new Error('Invalid cloud URL');
  // Browser builds may contain publishable keys only, never an administrative key.
  let publicKey = key.startsWith('sb_publishable_');
  if (key.startsWith('eyJ')) {
    try { publicKey = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch {}
  }
  if (!publicKey) throw new Error('A public Supabase key is required');
  return { url, key };
}

export function siteRoot(href, baseURI = href) {
  const base = new URL(baseURI);
  base.search = ''; base.hash = '';
  base.pathname = base.pathname.replace(/(?:auth\/callback|map|en)\/(?:index\.html)?$/, '');
  if (base.pathname.endsWith('/index.html')) base.pathname = base.pathname.slice(0, -10);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}

export function siteHref(path = '', language = null) {
  const url = new URL(path, siteRoot(location.href, document.baseURI));
  if (language) url.searchParams.set('lang', language);
  return url.href;
}

export function callbackDetails(href) {
  const url = new URL(href);
  const callback = /\/auth\/callback\/(?:index\.html)?$/.test(url.pathname);
  return { code: callback ? url.searchParams.get('code') : null,
    error: callback ? (url.searchParams.get('error') || new URLSearchParams(url.hash.slice(1)).get('error')) : null,
    cleanURL: new URL(url.pathname, url.origin).href };
}
