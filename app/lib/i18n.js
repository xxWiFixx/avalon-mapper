/* One locale for native messages, the map and every independent overlay. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../locales/en'), require('../locales/game-names.en'));
  else root.AvalonI18n = factory(root.AvalonEnglish || {}, root.AvalonGameNames || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (english, gameNames) {
  'use strict';
  let language = 'ru';
  const normalize = value => value === 'en' ? 'en' : 'ru';
  const locale = () => language === 'en' ? 'en-US' : 'ru-RU';
  function t(source, values) {
    let result = language === 'en' && Object.prototype.hasOwnProperty.call(english, source) ? english[source] : source;
    if (Array.isArray(values)) result = result.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match);
    return result;
  }
  function setLanguage(value) { language = normalize(value); return language; }
  function gameName(value) {
    if (language !== 'en' || typeof value !== 'string') return value;
    const [name, suffix] = value.split(' · T');
    return (gameNames[name] || name.replace(/^Моб #/, 'Mob #')) + (suffix === undefined ? '' : ' · T' + suffix);
  }
  function translateDocument(doc) {
    if (!doc) return;
    doc.documentElement.lang = language;
    const walker = doc.createTreeWalker(doc.documentElement, 4);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest('script, style, textarea, [data-i18n-ignore]')) continue;
      const text = node.nodeValue, key = text.replace(/\s+/g, ' ').trim();
      if (Object.prototype.hasOwnProperty.call(english, key)) node.nodeValue = text.match(/^\s*/)[0] + t(key) + text.match(/\s*$/)[0];
    }
    for (const element of doc.querySelectorAll('*')) {
      for (const attr of ['title', 'placeholder', 'aria-label', 'data-tip', 'alt']) {
        const value = element.getAttribute(attr);
        if (value && Object.prototype.hasOwnProperty.call(english, value)) element.setAttribute(attr, t(value));
      }
    }
  }
  if (typeof document !== 'undefined') {
    const preview = new URLSearchParams(location.search).get('lang');
    setLanguage(preview || globalThis.appLocale?.language || 'ru');
    document.documentElement.lang = language;
    globalThis.appLocale?.onChange(value => {
      if (normalize(value) !== language) location.reload();
    });
  }
  return { t, gameName, setLanguage, normalize, locale, translateDocument, get language() { return language; }, has: key => Object.prototype.hasOwnProperty.call(english, key) };
});
