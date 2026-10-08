'use client';

import React, { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, MotionConfig, motion, useInView, useMotionValue, useScroll, useSpring, useTransform } from 'framer-motion';
import { ArrowDown, ArrowDownRight, ArrowRight, ArrowUpRight, ArrowsOut, Check, DownloadSimple, GithubLogo, Pause, Play, X } from '@phosphor-icons/react';
import './styles.css';
import { LanguageProvider, useLanguage } from './localization.jsx';
import { AuthCallback, AuthProvider } from './cloud/AuthProvider.jsx';
import Header from './Header.jsx';
import './cloud/account.css';
const MapWorkspace = lazy(() => import('./cloud/MapWorkspace.jsx'));

const RELEASE = 'https://github.com/xxWiFixx/avalon-mapper/releases/latest';
const REPOSITORY = 'https://github.com/xxWiFixx/avalon-mapper';
const spring = { type: 'spring', stiffness: 100, damping: 24, mass: 1 };
const screens = {
  map: { title: 'Личная карта', alt: 'Карта Авалона с записанными порталами, временем жизни и картой выбранной зоны', height: 1200 },
  route: { title: 'Поиск маршрута', alt: 'Маршрут от Qiient-Qi-Odesas до Sleetwater Basin на карте Avalon Mapper', height: 1200 },
  overlay: { title: 'Запись портала', alt: 'Игровая подсказка портала и оверлей Avalon Mapper с картой зоны Coues-Exakrom', height: 1493 },
  'portal-scene': { title: 'Запись портала', alt: 'Карта игры с подсказкой портала Coues-Exakrom до распознавания', height: 1493 },
  shared: { title: 'Общая карта', alt: 'Карта группы в приложении Avalon Mapper', height: 1200 },
  statistics: { title: 'Статистика сессии', alt: 'Фейм в час, DPS участников группы и фейм по мобам в приложении', height: 1493 },
};
const asset = (name, width = 1920, language = 'ru') => `assets/${language === 'en' ? 'screens-en' : 'screens-ai'}/${name}-${width}.webp`;

function useMedia(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    mq.addEventListener('change', update);
    update();
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}

// Subscribe to changes too: Motion's hook currently captures the initial value only.
function useReducedMotion() {
  return useMedia('(prefers-reduced-motion: reduce)');
}

const Ambient = memo(function Ambient() {
  const { t, language, changeLanguage } = useLanguage();
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(() => {
    try { return localStorage.getItem('avalon-ambient-paused') === '1'; } catch { return false; }
  });
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const toggle = () => setPaused(value => {
    try { localStorage.setItem('avalon-ambient-paused', value ? '0' : '1'); } catch {}
    return !value;
  });
  return <>
    <div className={`page-ambient ${paused || hidden || reduced ? 'is-paused' : ''}`} aria-hidden="true">
      <div className="ambient-field ambient-field-warm"><i className="ambient-arc"/><i className="ambient-beacon"/></div>
      <div className="ambient-field ambient-field-cool"><i className="ambient-arc"/><i className="ambient-beacon"/></div>
      <div className="ambient-shade"/>
    </div>
    {!reduced && <button className="motion-toggle" onClick={toggle} aria-pressed={paused} aria-label={paused ? t("Продолжить анимацию фона") : t("Приостановить анимацию фона")}>
      {paused ? <Play size={15} weight="fill"/> : <Pause size={15} weight="fill"/>}<span>{paused ? t("Включить фон") : t("Пауза фона")}</span>
    </button>}
  </>;
});

function MagneticLink({ children, className = '', ...props }) {
  const reduced = useReducedMotion();
  const fine = useMedia('(pointer: fine)');
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 250, damping: 22 });
  const sy = useSpring(y, { stiffness: 250, damping: 22 });
  const move = event => {
    if (reduced || !fine) return;
    const box = event.currentTarget.getBoundingClientRect();
    x.set(((event.clientX - box.left) / box.width - .5) * 7);
    y.set(((event.clientY - box.top) / box.height - .5) * 7);
  };
  return <motion.a {...props} className={className} style={{ x: sx, y: sy }} onPointerMove={move} onPointerLeave={() => { x.set(0); y.set(0); }} whileTap={reduced ? undefined : { scale: .98 }}>{children}</motion.a>;
}

function ScreenImage({ name, eager = false, sizes = '(max-width: 760px) 92vw, 80vw', className = '', large = false }) {
  const { t, language, changeLanguage } = useLanguage();
  const [state, setState] = useState('loading');
  const [retry, setRetry] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current?.complete && ref.current.naturalWidth) setState('loaded');
  }, [name, retry, language]);
  return <div className={`screen-image ${className}`} data-state={state} style={{ aspectRatio: `1920 / ${screens[name].height}` }}>
    {state === 'error' ? <div className="media-error"><p>{t("Не удалось загрузить снимок.")}</p><button onClick={event => { event.stopPropagation(); setState('loading'); setRetry(value => value + 1); }}>{t("Попробовать снова")}{' '}<ArrowRight size={16}/></button></div> :
      <img ref={ref} key={retry} src={asset(name, large ? 3840 : 1920, language)} srcSet={large ? undefined : [960, 1920, 3840].map(width => `${asset(name, width, language)} ${width}w`).join(', ')} sizes={large ? undefined : sizes} width="1920" height={screens[name].height} alt={t(screens[name].alt)} loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : 'auto'} decoding="async" onLoad={() => setState('loaded')} onError={() => setState('error')}/>
    }
  </div>;
}

function ExpandButton({ name, open, className = '' }) {
  const { t, language, changeLanguage } = useLanguage();
  return <button className={`expand ${className}`} aria-label={t("Увеличить: {0}", [t(screens[name].title)])} onClick={() => open(name)}><ArrowsOut size={19}/></button>;
}

function Lightbox({ name, close }) {
  const { t, language, changeLanguage } = useLanguage();
  const dialog = useRef(null);
  useEffect(() => {
    if (!name) return;
    const node = dialog.current;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    node.showModal();
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      node.close();
      document.body.style.overflow = overflow;
      document.documentElement.style.overflow = rootOverflow;
      previous?.focus({ preventScroll: true });
    };
  }, [name]);
  return <dialog ref={dialog} className="lightbox" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="lightbox-title">
    {name && <><div className="lightbox-toolbar"><h2 id="lightbox-title" className="text-lg font-medium">{t(screens[name].title)}</h2><button autoFocus className="close-button" onClick={close} aria-label={t("Закрыть снимок")}><X size={24}/></button></div><div className="lightbox-content" style={{ '--lightbox-ratio': 1920 / screens[name].height }}><ScreenImage key={name} name={name} eager large/></div></>}
  </dialog>;
}

function Reveal({ children, className = '', delay = 0 }) {
  const reduced = useReducedMotion();
  return <motion.div className={className} initial={reduced ? false : { opacity: 0, y: 36 }} animate={reduced ? { opacity: 1, y: 0 } : undefined} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .15 }} transition={{ ...spring, delay }}>{children}</motion.div>;
}

function Hero({ open }) {
  const { t, language, changeLanguage } = useLanguage();
  const ref = useRef(null);
  const reduced = useReducedMotion();
  const compact = useMedia('(max-width: 1100px), (max-height: 640px)');
  const staticScene = reduced || compact;
  const [mobileRoute, setMobileRoute] = useState(false);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const p = useSpring(scrollYProgress, { stiffness: 80, damping: 28, restDelta: .001 });
  const x = useTransform(p, [0, .45, 1], ['30%', '0%', '0%']);
  const scale = useTransform(p, [0, .45, 1], [.82, 1, 1]);
  const rotateY = useTransform(p, [0, .45], [-18, 0]);
  const rotateX = useTransform(p, [0, .45], [7, 0]);
  const rotateZ = useTransform(p, [0, .45], [-3, 0]);
  const copyOpacity = useTransform(p, [0, .12, .3], [1, 1, 0]);
  const copyY = useTransform(p, [0, .32], [0, -70]);
  const copyVisibility = useTransform(p, value => value > .32 ? 'hidden' : 'visible');
  const chapterOpacity = useTransform(p, [.29, .42, .9, 1], [0, 1, 1, 0]);
  const chapterY = useTransform(p, [.29, .42], [24, 0]);
  const mapLabelOpacity = useTransform(p, [.45, .57], [1, 0]);
  const routeOpacity = useTransform(p, [.55, .75], [0, 1]);
  const routeVisibility = useTransform(p, value => value <= .55 ? 'hidden' : 'visible');
  const routeLabelOpacity = useTransform(p, [.6, .75], [0, 1]);
  const pathLength = useTransform(p, [.5, .73], [0, 1]);
  const pathOpacity = useTransform(p, [.48, .53, .74, .84], [0, 1, 1, 0]);
  const cueOpacity = useTransform(p, [0, .12], [1, 0]);
  const [viewName, setViewName] = useState('map');
  useEffect(() => {
    let current = 'map';
    return p.on('change', value => {
      const next = value > .67 ? 'route' : 'map';
      if (next !== current) { current = next; setViewName(next); }
    });
  }, [p]);
  return <section ref={ref} id="top" className={`hero ${staticScene ? 'hero-static' : ''}`} aria-labelledby="hero-title">
    <div className="hero-sticky">
      <motion.div className="hero-copy wrap" style={staticScene ? { opacity: 1, y: 0, visibility: 'visible' } : { opacity: copyOpacity, y: copyY, visibility: copyVisibility }}>
        <motion.div initial={reduced ? false : { opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: .1 }}>
          <p className="eyebrow mb-6">{t("Для тех, кто идёт в Авалон")}</p>
          <h1 id="hero-title">{t("Твоя карта")}<br/>{t("Дорог Авалона")}<span className="hero-period">.</span></h1>
          <p className="hero-description mt-7">{t("Записывай порталы. Находи выход.")}<br className="hidden sm:block"/>{' '}{t("Исследуй мир Albion Online вместе.")}</p>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
            <MagneticLink className="button-primary" href={RELEASE}>{t("Скачать для Windows")}{' '}<DownloadSimple size={18}/></MagneticLink>
            <a href="#capture" className="text-link">{t("Как это работает")}{' '}<ArrowDownRight size={17}/></a>
          </div>
          <p className="mt-4 text-[13px] text-muted">{t("Windows · Код на GitHub")}</p>
        </motion.div>
      </motion.div>

      {!staticScene && <motion.div className="hero-chapter" style={{ opacity: chapterOpacity, y: chapterY }} aria-hidden="true">
        <motion.div style={{ opacity: mapLabelOpacity }}><p className="eyebrow mb-3">{t("Личная карта")}</p><p className="chapter-title">{t("Каждый портал — часть пути.")}</p></motion.div>
        <motion.div className="absolute inset-0" style={{ opacity: routeLabelOpacity }}><p className="eyebrow mb-3">{t("Построение маршрута")}</p><p className="chapter-title">{t("Теперь ты знаешь, куда идти.")}</p></motion.div>
      </motion.div>}

      <div className="hero-product-position">
        <motion.div className="hero-product" style={staticScene ? { x: 0, scale: 1, rotateY: 0, rotateX: 0, rotateZ: 0 } : { x, scale, rotateY, rotateX, rotateZ }}>
          <motion.div initial={reduced ? false : { opacity: 0, y: compact ? 35 : 100, rotateY: compact ? 0 : -10, rotateX: compact ? 8 : 0 }} animate={compact && !reduced ? undefined : { opacity: 1, y: 0, rotateY: 0, rotateX: 0 }} whileInView={{ opacity: 1, y: 0, rotateY: 0, rotateX: 0 }} viewport={{ once: true, amount: .1 }} transition={{ ...spring, delay: .22 }} className="hero-frame">
            <ScreenImage name="map" eager sizes="(max-width: 1100px) 92vw, 1300px"/>
            <motion.div className="absolute inset-0" style={staticScene ? { visibility: mobileRoute ? 'visible' : 'hidden' } : { opacity: routeOpacity, visibility: routeVisibility }} animate={staticScene ? { opacity: mobileRoute ? 1 : 0 } : undefined} transition={{ duration: .6 }}>
              <ScreenImage name="route" eager sizes="(max-width: 1100px) 92vw, 1300px"/>
            </motion.div>
            {!staticScene && <motion.svg className="route-trace absolute inset-0 h-full w-full pointer-events-none" viewBox="0 0 1920 1200" fill="none" style={{ opacity: pathOpacity }} aria-hidden="true"><motion.path d="M 961 475 L 1143 469 M 1152 483 L 1002 840" stroke="#f0ca84" strokeWidth="3" strokeLinecap="round" style={{ pathLength }}/></motion.svg>}
            <ExpandButton name={staticScene ? mobileRoute ? 'route' : 'map' : viewName} open={open}/>
          </motion.div>
        </motion.div>
      </div>

      {staticScene ? <div className="wrap mt-6 flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-muted">{t("Интерфейс Avalon Mapper")}</span><button className="text-link text-sm" onClick={() => setMobileRoute(value => !value)}>{mobileRoute ? t("Показать карту") : t("Построить маршрут")}<ArrowRight size={17}/></button></div> : <>
        <motion.a href="#capture" className="scroll-cue" style={{ opacity: cueOpacity }}><span>{t("Прокрути, чтобы исследовать")}</span><ArrowDown size={17}/></motion.a>
        <motion.div className="hero-timeline" style={{ opacity: chapterOpacity }} aria-hidden="true"><span>{t("Карта")}</span><span className="timeline-track"><motion.i style={{ scaleX: p }}/></span><span>{t("Маршрут")}</span></motion.div>
      </>}
    </div>
  </section>;
}

function Capture({ open }) {
  const { t, language, changeLanguage } = useLanguage();
  const ref = useRef(null);
  const reduced = useReducedMotion();
  const inView = useInView(ref, { amount: .25 });
  const [run, setRun] = useState(0);
  const [active, setActive] = useState(false);
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [45, -40]);
  const rotate = useTransform(scrollYProgress, [0, .6], [-3, 0]);
  const capture = useCallback(() => {
    clearTimeout(timer.current);
    setRun(value => value + 1); setActive(true); setDone(false);
    timer.current = setTimeout(() => { setActive(false); setDone(true); }, reduced ? 100 : 2300);
  }, [reduced]);
  useEffect(() => {
    if (!inView) return;
    const key = event => { if (event.key === 'F9' && !event.repeat && !document.querySelector('dialog[open]')) { event.preventDefault(); capture(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [inView, capture]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <section id="capture" ref={ref} className="capture-section section-space wrap" aria-labelledby="capture-title">
    <div className="grid items-center gap-12 lg:grid-cols-[1.35fr_1fr] lg:gap-24">
      <motion.div className="capture-visual relative order-2 lg:order-1" style={reduced ? { y: 0, rotate: 0 } : { y, rotate }}>
        <Reveal><div className="capture-frame relative overflow-hidden">
          <motion.div key={`capture-zoom-${run}`} style={{ transformOrigin: '53% 45%' }} animate={active && !reduced ? { scale: [1, 1.35, 1.35, 1] } : { scale: 1 }} transition={{ duration: 2.25, times: [0, .24, .72, 1], ease: [.22, 1, .36, 1] }}><ScreenImage name="portal-scene" sizes="(max-width: 1024px) 92vw, 60vw"/></motion.div>
          {!reduced && active && <motion.div key={`capture-scan-${run}`} className="scan-line" initial={{ y: '-10%' }} animate={{ y: '1050%' }} transition={{ duration: 1.3, ease: [.25, .1, .25, 1] }} aria-hidden="true"/>}
          <motion.div className="capture-focus" animate={{ opacity: active && !reduced ? [0, 1, 1, 0] : 0, scale: active ? [1, 1.35, 1.35, 1] : 1 }} transition={{ duration: reduced ? 0 : 2.25, times: [0, .24, .72, 1] }} aria-hidden="true"><i/><i/><i/><i/></motion.div>
          <motion.img className="capture-overlay" src={asset('portal-overlay', 1920, language)} srcSet={[960, 1920, 3840].map(width => `${asset('portal-overlay', width, language)} ${width}w`).join(', ')} sizes="(max-width: 1024px) 92vw, 60vw" width="1920" height="1493" loading="lazy" decoding="async" alt="" aria-hidden="true" initial={false} animate={{ opacity: done ? 1 : 0, y: done || reduced ? 0 : 12, scale: done || reduced ? 1 : .98 }} transition={{ duration: reduced || !done ? 0 : .5, ease: [.22, 1, .36, 1] }}/>
          <ExpandButton name={done ? 'overlay' : 'portal-scene'} open={open}/>
        </div></Reveal>
        <div className="mt-5 flex items-center justify-between gap-4 text-[13px] text-muted"><span>{t("Подсказка в игре → оверлей с картой зоны")}</span><span className="hidden sm:inline">{t("01 / Запись")}</span></div>
      </motion.div>
      <Reveal className="order-1 lg:order-2">
        <p className="eyebrow mb-5">{t("Не теряй найденное")}</p>
        <h2 id="capture-title" className="section-title">{t("Один хоткей.")}<br/>{t("Портал на карте.")}</h2>
        <p className="body-copy mt-7">{t("Наведи курсор на портал и нажми F9. Приложение прочитает название зоны, вместимость и время до закрытия.")}</p>
        <p className="body-copy mt-5">{t("Карта зоны появится поверх игры. Можно идти дальше.")}</p>
        <div className="mt-10 flex items-center gap-5">
          <motion.button className="keycap" aria-label={t("F9 — показать анимацию записи портала")} onClick={capture} whileTap={reduced ? undefined : { y: 3, scale: .96 }} animate={{ y: active ? 2 : 0 }}>F9</motion.button>
          <div className="demo-status" aria-live="polite"><AnimatePresence mode="wait"><motion.p key={active ? 'reading' : done ? 'done' : 'idle'} initial={reduced ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: .2 }}>{active ? t("Читаем подсказку…") : done ? <><Check size={16}/>{' '}{t("Портал распознан")}</> : t("Попробуй прямо здесь")}</motion.p></AnimatePresence><span className="mt-1 block text-xs text-muted">{t("Демонстрация на снимке")}</span></div>
        </div>
      </Reveal>
    </div>
  </section>;
}

function Together({ open }) {
  const { t, language, changeLanguage } = useLanguage();
  const ref = useRef(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'center center'] });
  const rotateY = useTransform(scrollYProgress, [0, 1], [-13, 0]);
  const x = useTransform(scrollYProgress, [0, 1], [80, 0]);
  return <section id="together" ref={ref} className="together-section section-space" aria-labelledby="together-title">
    <div className="wrap grid items-center gap-14 lg:grid-cols-[.8fr_1.5fr] lg:gap-20">
      <Reveal><p className="eyebrow mb-5">{t("Исследуй вместе")}</p><h2 id="together-title" className="section-title">{t("Разные пути.")}<br/>{t("Общая карта.")}</h2><p className="body-copy mt-7">{t("Включи отправку порталов на выбранный сервер друзей. Его карту видят только участники сервера.")}</p><div className="mt-9 space-y-0 text-[15px]"><p className="feature-line">{t("Приглашение по коду")}</p><p className="feature-line">{t("Совместная запись порталов")}</p><p className="feature-line">{t("Личная карта для соло-выходов")}</p></div></Reveal>
      <div className="shared-perspective"><motion.figure style={reduced ? { rotateY: 0, x: 0 } : { rotateY, x }}><div className="shared-frame relative overflow-hidden"><ScreenImage name="shared" sizes="(max-width: 1024px) 92vw, 70vw"/><ExpandButton name="shared" open={open}/></div><figcaption className="mt-5 flex justify-between text-[13px] text-muted"><span>{t("Карта вашей группы")}</span><span>{t("03 / Вместе")}</span></figcaption></motion.figure></div>
    </div>
    <Pricing/>
  </section>;
}

function Statistics({ open }) {
  const { t, language, changeLanguage } = useLanguage();
  const ref = useRef(null);
  const frame = useRef(null);
  const reduced = useReducedMotion();
  const compact = useMedia('(max-width: 900px), (max-height: 640px)');
  const staticScene = reduced || compact;
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const p = useSpring(scrollYProgress, { stiffness: 90, damping: 28 });
  const overflow = useMotionValue(0);
  useEffect(() => {
    const measure = () => overflow.set(Math.max(0, frame.current.firstElementChild.offsetHeight - frame.current.clientHeight));
    const observer = new ResizeObserver(measure);
    observer.observe(frame.current);
    observer.observe(frame.current.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [overflow]);
  const imageY = useTransform([p, overflow], ([progress, distance]) => -distance * Math.min(1, Math.max(0, (progress - .12) / .76)));
  const imageScale = useTransform(p, [0, .25, 1], [1.04, 1, 1]);
  const line = useTransform(p, [0, 1], [.1, 1]);
  return <section ref={ref} id="statistics" className={`statistics ${staticScene ? 'statistics-static' : ''}`} aria-labelledby="statistics-title"><div className="statistics-sticky wrap">
    <div className="grid gap-7 pb-10 md:grid-cols-[1.15fr_1fr] md:items-end md:gap-16"><Reveal><p className="eyebrow mb-5">{t("Каждый выход в цифрах")}</p><h2 id="statistics-title" className="section-title">{t("Как прошла охота?")}</h2></Reveal><Reveal delay={.08}><p className="body-copy max-w-[460px]">{t("Фейм в час. Урон и DPS группы. Награда за каждого моба. Вся сессия — перед глазами.")}</p></Reveal></div>
    <div ref={frame} className="stats-window relative overflow-hidden"><motion.div style={staticScene ? { y: 0, scale: 1 } : { y: imageY, scale: imageScale }}><ScreenImage name="statistics" sizes="(max-width: 900px) 92vw, 1280px"/></motion.div><ExpandButton name="statistics" open={open}/></div>
    <div className="mt-5 flex items-center justify-between gap-6 text-[13px] text-muted"><span>{t("Статистика и оверлеи фейма / урона")}</span><div className="flex items-center gap-4"><span className="hidden sm:inline">{t("02 / Сессия")}</span>{!staticScene && <span className="stats-progress"><motion.i style={{ scaleX: line }}/></span>}</div></div>
  </div></section>;
}

function Pricing() {
  const { t, language } = useLanguage();
  return <section id="pricing" className="pricing-section wrap server-pricing" aria-labelledby="pricing-title">
    <Reveal className="pricing-intro">
      <p className="eyebrow mb-5">{t('Групповые серверы')}</p>
      <h2 id="pricing-title" className="section-title whitespace-pre-line">{t('Свой сервер для друзей')}</h2>
      <p className="body-copy mt-7 max-w-[590px]">{t('Приложение бесплатно. Владелец группового сервера активирует код на 30 дней; участники подключаются бесплатно.')}</p>
    </Reveal>
    <Reveal className="plan-row" delay={.06}>
      <div className="plan-name"><span className="plan-number">01</span><div><p className="eyebrow mb-3">{t('Сервер для группы')}</p><h3 className="whitespace-pre-line">{t('Одна оплата.\nОбщая карта.')}</h3></div></div>
      <div className="plan-description"><p>{t('Закрытая карта для друзей или гильдии. Владелец оплачивает свой групповой сервер, остальные присоединяются по приглашению.')}</p><p className="mt-4">{t('Все участники бесплатно записывают и смотрят порталы без дневного лимита.')}</p></div>
      <div className="plan-price"><strong>{language === 'en' ? '$8.99' : '799'}</strong><span>{t('₽ / сервер · 30 дней')}</span><span className="plan-status">{t('По коду')}</span></div>
    </Reveal>
    <div className="pricing-footnote"><p>{t('Создание сервера: «+» → название и код активации. Продление: Настройки → Мои сервера или ПКМ по серверу → Подписка. Код добавляет 30 дней к оставшемуся сроку.')}</p><a className="text-link" href={`${REPOSITORY}/blob/main/docs/privacy.md`}>{t('Как сейчас хранятся карты')}<ArrowUpRight size={15}/></a></div>
  </section>;
}

function Footer() {
  const { t, language, changeLanguage } = useLanguage();
  return <footer id="download" className="wrap pt-28 pb-24 md:pt-40">
    <Reveal><div className="grid items-end gap-10 border-t border-line pt-14 md:grid-cols-[1.3fr_1fr] md:pt-20"><div><p className="eyebrow mb-5">Avalon Mapper</p><h2 className="section-title">{t("Увидимся")}<br/>{t("по ту сторону.")}</h2></div><div className="md:pb-2"><p className="body-copy mb-7 max-w-[360px]">{t("Твоя следующая дорога начинается с первого портала.")}</p><MagneticLink href={RELEASE} className="button-primary">{t("Скачать для Windows")}{' '}<DownloadSimple size={18}/></MagneticLink><p className="mt-4 text-[13px] text-muted">{t("Последняя версия на GitHub Releases")}</p></div></div></Reveal>
    <div className="mt-24 flex flex-wrap items-center justify-between gap-x-8 gap-y-6 border-t border-line pt-7 text-[12px] text-muted"><p>{t("Независимый проект для игроков Albion Online.")}</p><a className="quiet-link inline-flex items-center gap-2" href={REPOSITORY}><GithubLogo size={17}/>{' '}{t("Исходный код")}{' '}<ArrowUpRight size={14}/></a><p className="w-full text-[11px] text-muted/80">{t("Albion Online — игра Sandbox Interactive GmbH. Проект не связан с разработчиками игры. На снимках показаны демонстрационные данные.")}</p></div>
  </footer>;
}

function App() {
  const { t, language, changeLanguage } = useLanguage();
  const reduced = useReducedMotion();
  const [lightbox, setLightbox] = useState(null);
  const open = useCallback(name => setLightbox(name), []);
  const close = useCallback(() => setLightbox(null), []);
  const page = /\/auth\/callback\/(?:index\.html)?$/.test(location.pathname) ? 'auth' : /\/map\/(?:index\.html)?$/.test(location.pathname) ? 'map' : 'landing';
  if (page !== 'landing') return page === 'auth' ? <><Header/><AuthCallback/></> : <Suspense fallback={<div className="map-login">{t('Загрузка карт…')}</div>}><MapWorkspace/></Suspense>;
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'} skipAnimations={reduced}><Ambient/><a className="skip-link" href="#capture">{t("К возможностям приложения")}</a><Header/><main><Hero open={open}/><Capture open={open}/><section className="wrap free-app-summary">    <Reveal className="free-allowance" delay={.05}>
      <div><p className="eyebrow mb-3">{t('Бесплатно для каждого')}</p><h3>{t('Записывай без лимита.')}</h3></div>
      <div><p>{t('Автоматическая и ручная запись порталов — бесплатно и без дневного лимита.')}</p><p className="mt-4">{t('Личная карта, маршруты и статистика бесплатны. Время закрытия портала всегда настоящее.')}</p></div>
    </Reveal>
</section><Statistics open={open}/><Together open={open}/></main><Footer/><Lightbox name={lightbox} close={close}/></MotionConfig>;
}

createRoot(document.getElementById('root')).render(<LanguageProvider><AuthProvider><App/></AuthProvider></LanguageProvider>);
