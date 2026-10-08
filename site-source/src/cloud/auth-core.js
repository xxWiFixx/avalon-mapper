export function discordUser(user) {
  if (!user || user.is_anonymous || !/^[0-9a-f-]{36}$/i.test(user.id || '')) return null;
  if (!user.identities?.some(identity => identity.provider === 'discord')
      && user.app_metadata?.provider !== 'discord') return null;
  const metadata = user.user_metadata || {};
  let avatar = null;
  try {
    const url = new URL(metadata.avatar_url);
    if (url.protocol === 'https:' && /(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/.test(url.hostname)) avatar = url.href;
  } catch {}
  return { id: user.id, name: String(metadata.custom_claims?.global_name || metadata.full_name
    || metadata.name || metadata.preferred_username || 'Discord').slice(0, 80), avatar };
}

function bounded(promise, timeoutMs = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('session_unavailable')), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

// The user is verified by Auth; cached browser metadata is never trusted as a login.
export function createSiteAuth(client, { onChange = () => {}, verificationTimeoutMs = 12000 } = {}) {
  let epoch = 0;
  let activeValidation = 0;
  let state = { user: null, loading: true, error: null };
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  async function restore({ code = null, error = null } = {}) {
    const started = ++epoch;
    activeValidation = started;
    // A token refresh for the same account must not unmount the map and discard
    // its current selection. A new OAuth callback still starts from a blank state.
    const previous = !code && !error ? state.user : null;
    emit({ user: previous, loading: !previous, error: null });
    try {
      if (error) throw new Error('oauth_cancelled');
      if (code) {
        const result = await bounded(client.auth.exchangeCodeForSession(code), verificationTimeoutMs);
        if (result.error) throw new Error('oauth_failed');
      }
      const cached = await bounded(client.auth.getSession(), verificationTimeoutMs);
      if (cached.error) throw new Error('session_unavailable');
      if (!cached.data?.session) { if (started === epoch) emit({ user: null, loading: false }); return; }
      if (previous && cached.data.session.user?.id && cached.data.session.user.id !== previous.id && started === epoch)
        emit({ user: null, loading: true });
      const verified = await bounded(client.auth.getUser(), verificationTimeoutMs);
      if (verified.error) throw new Error('session_unavailable');
      const user = discordUser(verified.data?.user);
      if (!user) throw new Error('discord_required');
      if (started === epoch) emit({ user, loading: false, error: null });
    } catch (err) {
      if (started === epoch) emit({ user: null, loading: false, error: err.message });
    } finally { if (activeValidation === started) activeValidation = 0; }
  }
  async function signIn(redirectTo) {
    emit({ error: null });
    const { error } = await client.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo, scopes: 'identify' } });
    if (error) { emit({ error: 'oauth_failed' }); throw new Error('oauth_failed'); }
  }
  async function signOut() {
    ++epoch;
    activeValidation = 0;
    // Clear private UI immediately, even if a pending request finishes afterwards.
    emit({ user: null, loading: false, error: null });
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) emit({ error: 'signout_failed' });
  }
  function sessionEvent(event, session) {
    if (event === 'SIGNED_OUT' || (event === 'TOKEN_REFRESHED' && !session)) {
      ++epoch; activeValidation = 0; emit({ user: null, loading: false, error: null });
    } else if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED') {
      if (!session) return;
      const changedAccount = !!(state.user && session.user?.id && session.user.id !== state.user.id);
      if (changedAccount) {
        ++epoch; activeValidation = 0; emit({ user: null, loading: true, error: null });
      }
      if (activeValidation || (state.loading && !changedAccount)) return;
      // Auth callbacks must return synchronously; calling Auth inside them can deadlock.
      const scheduled = epoch;
      setTimeout(() => { if (scheduled === epoch) void restore(); }, 0);
    }
  }
  return { restore, signIn, signOut, sessionEvent, getState: () => state };
}
