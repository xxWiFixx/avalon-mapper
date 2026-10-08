import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { cloudEnglish } from './cloud/messages.js';
import { appEnglish } from './cloud/generated/messages.js';

export const english = {
 'Свой сервер для друзей':'Your own server for friends',
 'Создание сервера: «+» → название и код активации. Продление: Настройки → Мои сервера или ПКМ по серверу → Подписка. Код добавляет 30 дней к оставшемуся сроку.':'Create a server: + → name and activation code. Renew in Settings → My servers or right-click the server → Subscription. Each code adds 30 days to the remaining term.',
  'Личная карта': 'Personal map',
  'Карта Авалона с записанными порталами, временем жизни и картой выбранной зоны': 'Roads of Avalon map with recorded portals, expiry times and the selected zone map',
  'Поиск маршрута': 'Route finder',
  'Маршрут от Qiient-Qi-Odesas до Sleetwater Basin на карте Avalon Mapper': 'Route from Qiient-Qi-Odesas to Sleetwater Basin in Avalon Mapper',
  'Запись портала': 'Portal capture',
  'Игровая подсказка портала и оверлей Avalon Mapper с картой зоны Coues-Exakrom': 'In-game portal tooltip and the Avalon Mapper overlay for Coues-Exakrom',
  'Карта игры с подсказкой портала Coues-Exakrom до распознавания': 'In-game map showing the Coues-Exakrom portal before capture',
  'Общая карта': 'Group map',
  'Карта группы в приложении Avalon Mapper': 'A shared group map in Avalon Mapper',
  'Статистика сессии': 'Session statistics',
  'Фейм в час, DPS участников группы и фейм по мобам в приложении': 'Fame per hour, party DPS and fame by mob in the app',
  'Продолжить анимацию фона': 'Resume background animation',
  'Приостановить анимацию фона': 'Pause background animation',
  'Включить фон': 'Resume motion',
  'Пауза фона': 'Pause motion',
  'Не удалось загрузить снимок.': 'The screenshot could not be loaded.',
  'Попробовать снова': 'Try again',
  'Увеличить: {0}': 'Enlarge: {0}',
  'Закрыть снимок': 'Close screenshot',
  'Avalon Mapper — начало страницы': 'Avalon Mapper — back to top',
  'Основная навигация': 'Main navigation',
  'Возможности': 'Features',
  'Для группы': 'For groups',
  'Скачать': 'Download',
  'Для тех, кто идёт в Авалон': 'For those who venture into Avalon',
  'Твоя карта': 'Your map of',
  'Дорог Авалона': 'the Roads of Avalon',
  'Записывай порталы. Находи выход.': 'Capture portals. Find your way out.',
  'Исследуй мир Albion Online вместе.': 'Explore Albion Online together.',
  'Скачать для Windows': 'Download for Windows',
  'Как это работает': 'See how it works',
  'Windows · Код на GitHub': 'Windows · Source on GitHub',
  'Каждый портал — часть пути.': 'Every portal is part of your journey.',
  'Построение маршрута': 'Route planning',
  'Теперь ты знаешь, куда идти.': 'Now you know where to go.',
  'Интерфейс Avalon Mapper': 'The Avalon Mapper app',
  'Показать карту': 'Show map',
  'Построить маршрут': 'Find a route',
  'Прокрути, чтобы исследовать': 'Scroll to explore',
  'Карта': 'Map',
  'Маршрут': 'Route',
  'Подсказка в игре → оверлей с картой зоны': 'In-game tooltip → zone map overlay',
  '01 / Запись': '01 / Capture',
  'Не теряй найденное': 'Keep what you discover',
  'Один хоткей.': 'One hotkey.',
  'Портал на карте.': 'A portal on your map.',
  'Наведи курсор на портал и нажми F9. Приложение прочитает название зоны, вместимость и время до закрытия.': 'Hover over a portal and press F9. The app reads the zone name, capacity and time until it closes.',
  'Карта зоны появится поверх игры. Можно идти дальше.': 'The zone map appears over your game. Keep exploring.',
  'F9 — показать анимацию записи портала': 'F9 — play the portal capture demo',
  'Читаем подсказку…': 'Reading the tooltip…',
  'Портал распознан': 'Portal recognised',
  'Попробуй прямо здесь': 'Try it right here',
  'Демонстрация на снимке': 'Demo using a real screenshot',
  'Исследуй вместе': 'Explore together',
  'Разные пути.': 'Different paths.',
  'Общая карта.': 'One shared map.',
  'Включи отправку порталов на выбранный сервер друзей. Его карту видят только участники сервера.': 'Enable portal sharing with a selected friends’ server. Only its members can view that map.',
  'Приглашение по коду': 'Invite with a code',
  'Совместная запись порталов': 'Capture portals together',
  'Личная карта для соло-выходов': 'A personal map for solo trips',
  'Карта вашей группы': 'Your group’s map',
  '02 / Вместе': '02 / Together',
  'Каждый выход в цифрах': 'Every session, in numbers',
  'Как прошла охота?': 'How was the hunt?',
  'Фейм в час. Урон и DPS группы. Награда за каждого моба. Вся сессия — перед глазами.': 'Fame per hour. Party damage and DPS. Fame earned from each mob. Your whole session at a glance.',
  'Статистика и оверлеи фейма / урона': 'Statistics and fame / damage overlays',
  '03 / Сессия': '03 / Session',
  'Увидимся': 'See you',
  'по ту сторону.': 'on the other side.',
  'Твоя следующая дорога начинается с первого портала.': 'Your next journey starts with the first portal.',
  'Последняя версия на GitHub Releases': 'Latest version on GitHub Releases',
  'Независимый проект для игроков Albion Online.': 'An independent project for Albion Online players.',
  'Исходный код': 'Source code',
  'Albion Online — игра Sandbox Interactive GmbH. Проект не связан с разработчиками игры. На снимках показаны демонстрационные данные.': 'Albion Online is developed by Sandbox Interactive GmbH. This project is not affiliated with the game’s developers. Screenshots show demonstration data.',
  'К возможностям приложения': 'Skip to features',
  'Стоимость сервера': 'Server pricing',
  'Планируемые платные функции': 'Planned paid features',
  'Для твоих дорог.\nДля вашей группы.': 'For your journeys.\nFor your group.',
  'Приложение бесплатно. Готовим подписку только для владельца группового канала. Оплата пока не включена.': 'The app is free. We are preparing a subscription only for group channel owners. Payments are not enabled yet.',
  'Бесплатно для каждого': 'Free for everyone',
  'Записывай без лимита.': 'Capture without limits.',
  'Автоматическая и ручная запись порталов — бесплатно и без дневного лимита.': 'Free automatic and manual portal captures, with no daily limit.',
  'Личная карта, маршруты и статистика бесплатны. Время закрытия портала всегда настоящее.': 'Your personal map, route planning and statistics are free. Portals always keep their real expiry time.',
  'Сервер для группы': 'Group server',
  'Одна оплата.\nОбщая карта.': 'One payment.\nOne shared map.',
  'Закрытая карта для друзей или гильдии. Владелец оплачивает свой групповой сервер, остальные присоединяются по приглашению.': 'A private map for friends or a guild. The owner pays for their group server; everyone else joins by invitation.',
  'Все участники бесплатно записывают и смотрят порталы без дневного лимита.': 'All members capture and view portals for free, with no daily limit.',
  '₽ / месяц': 'USD / month',
  'Скоро': 'Coming soon',
  "Групповые серверы": "Group servers",
  "Приложение бесплатно. Владелец группового сервера активирует код на 30 дней; участники подключаются бесплатно.": "The app is free. The group server owner activates a 30-day code; members join for free.",
  "₽ / 30 дней": "/ 30 days",
  "По коду": "Activation code",
  "Введи код в настройках → Подписка или через ПКМ по серверу → Подписка. Продление добавляет 30 дней к оставшемуся сроку.": "Enter your code in Settings → Subscription, or right-click your server → Subscription. Renewing adds 30 days to the remaining time.",
  'Покупка появится в приложении после запуска тарифов.': 'Purchases will become available in the app when plans launch.',
  'Как сейчас хранятся карты': 'How maps are stored today',
  'Выбрать язык': 'Choose language',
  'Avalon Mapper — карта Дорог Авалона': 'Avalon Mapper — map the Roads of Avalon',
  'Avalon Mapper для Albion Online: запись порталов по хоткею, маршруты через Авалон, общая карта группы и статистика сессии.': 'Avalon Mapper for Albion Online: capture portals with a hotkey, find routes through Avalon, share group maps and track your session. Group access is activated with a 30-day code.',
};
const Language = createContext(null);
const initialLanguage = () => {
  const query = new URLSearchParams(location.search).get('lang');
  if (query === 'en' || query === 'ru') return query;
  if (location.pathname.endsWith('/en/') || location.pathname.endsWith('/en/index.html')) return 'en';
  try { return localStorage.getItem('avalon-site-language') === 'en' ? 'en' : 'ru'; } catch { return 'ru'; }
};
export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(initialLanguage);
  const t = useCallback((source, values) => {
    const translated = language === 'en' ? cloudEnglish[source] ?? english[source] ?? appEnglish[source] ?? source : source;
    return values ? translated.replace(/\{(\d+)\}/g, (match, i) => i < values.length ? String(values[i]) : match) : translated;
  }, [language]);
  const changeLanguage = useCallback(value => {
    const next = value === 'en' ? 'en' : 'ru';
    const url = new URL(location.href); url.searchParams.set('lang', next);
    history.replaceState(null, '', url);
    try { localStorage.setItem('avalon-site-language', next); } catch {}
    setLanguage(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    try { localStorage.setItem('avalon-site-language', language); } catch {}
    document.title = t('Avalon Mapper — карта Дорог Авалона');
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) document.querySelector(selector)?.setAttribute('content', t('Avalon Mapper для Albion Online: запись порталов по хоткею, маршруты через Авалон, общая карта группы и статистика сессии.'));
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
    document.querySelector('meta[property="og:locale"]')?.setAttribute('content', language === 'en' ? 'en_US' : 'ru_RU');
    document.querySelector('meta[property="og:image"]')?.setAttribute('content', language === 'en' ? 'assets/screens-en/map-1920.webp' : 'assets/screens-ai/map-1920.webp');
  }, [language, t]);
  useEffect(() => {
    const update = () => setLanguage(initialLanguage());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return <Language.Provider value={{ language, t, changeLanguage }}>{children}</Language.Provider>;
}
export const useLanguage = () => useContext(Language);
