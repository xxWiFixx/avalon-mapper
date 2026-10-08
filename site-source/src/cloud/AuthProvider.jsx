import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { SignOut } from '@phosphor-icons/react';
import { useLanguage } from '../localization.jsx';
import { createSiteAuth } from './auth-core.js';
import { callbackDetails, siteHref } from './config.js';
import discordClyde from './assets/discord-clyde.svg';

export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
let runtimePromise;
export const getRuntime = () => runtimePromise ||= import('./client.js');

export function AuthProvider({ children }) {
  const [state, setState] = useState({ user: null, loading: true, error: null });
  const auth = useRef(null);
  useEffect(() => {
    let disposed = false, subscription, resume;
    const callback = callbackDetails(location.href);
    if (callback.code || callback.error) history.replaceState(null, '', callback.cleanURL);
    getRuntime().then(({ client }) => {
      if (disposed) return;
      const instance = createSiteAuth(client, { onChange: value => { if (!disposed) setState(value); } });
      auth.current = instance;
      subscription = client.auth.onAuthStateChange((event, session) => instance.sessionEvent(event, session)).data.subscription;
      let lastResume = Date.now();
      resume = () => {
        if (disposed || document.hidden || Date.now() - lastResume < 1000) return;
        const current = instance.getState();
        if (current.user || (!current.loading && !current.error)) return;
        lastResume = Date.now();
        void instance.restore();
      };
      window.addEventListener('focus', resume);
      document.addEventListener('visibilitychange', resume);
      void instance.restore(callback);
    }).catch(() => { if (!disposed) setState({ user: null, loading: false, error: 'session_unavailable' }); });
    return () => { disposed = true; subscription?.unsubscribe(); if (resume) { window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); } auth.current = null; };
  }, []);
  const signIn = async () => {
    try { await auth.current?.signIn(siteHref('auth/callback/')); } catch {}
  };
  const signOut = async () => { await auth.current?.signOut(); };
  const retry = async () => { if (auth.current) await auth.current.restore(); else location.reload(); };
  return <AuthContext.Provider value={{ ...state, signIn, signOut, retry }}>{children}</AuthContext.Provider>;
}

export function AccountLink() {
  const { user, loading, signIn } = useAuth();
  const { language, t } = useLanguage();
  return user
    ? <a className="account-link" href={siteHref('map/', language)}>{user.avatar && <img src={user.avatar} alt="" width="22" height="22" referrerPolicy="no-referrer"/>}<span>{t('Мои карты')}</span></a>
    : <button className="account-link" onClick={signIn} disabled={loading}><img className="discord-clyde" src={discordClyde} alt="" width="25" height="19"/><span>{loading ? t('Подключение') : t('Войти')}</span></button>;
}

export function SignOutButton() {
  const { signOut } = useAuth();
  const { t } = useLanguage();
  return <button className="map-icon-button" onClick={signOut} title={t('Выйти')} aria-label={t('Выйти')}><SignOut size={19}/></button>;
}

export function LoginPanel() {
  const { loading, error, signIn, retry } = useAuth();
  const { t } = useLanguage();
  return <section className="map-login" aria-labelledby="map-login-title">
    <div className="map-login-mark"><img className="discord-clyde" src={discordClyde} alt="" width="51" height="38"/></div>
    <p className="eyebrow">{t('Твои дороги. На любом устройстве.')}</p>
    <h1 id="map-login-title">{loading ? t('Проверяем вход…') : t('Твоя карта всегда рядом.')}</h1>
    <p>{t('Войди через тот же Discord, что и в приложении. Здесь будут твои порталы и карты твоих групп.')}</p>
    <p className="map-login-note">{t('Можно открыть с телефона. Установка приложения для просмотра не нужна.')}</p>
    {!loading && <button className="button-primary" onClick={signIn}><img className="discord-clyde" src={discordClyde} alt="" width="27" height="20"/>{t('Войти через Discord')}</button>}
    {error && <div className="map-notice" role="alert"><span>{t('Не удалось завершить вход. Попробуй снова.')}</span><button onClick={retry}>{t('Повторить')}</button></div>}
  </section>;
}

export function AuthCallback() {
  const { user, loading } = useAuth();
  const { language } = useLanguage();
  useEffect(() => { if (user && !loading) location.replace(siteHref('map/', language)); }, [user, loading, language]);
  return <LoginPanel/>;
}
