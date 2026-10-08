import { createClient } from '@supabase/supabase-js';
import { cloudConfig } from './config.js';

const config = cloudConfig(import.meta.env);
export const client = createClient(config.url, config.key, {
  auth: { flowType: 'pkce', detectSessionInUrl: false, autoRefreshToken: true,
    persistSession: true, storageKey: 'avalon-mapper-web-auth' },
});

export async function rpc(name, body = {}, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { data, error, status } = await client.rpc(name, body).abortSignal(controller.signal);
    if (error) {
      const failure = new Error('cloud_request_failed');
      failure.status = status; failure.code = error.code;
      if (['group_subscription_required','group_subscription_expired','map_owner_required'].includes(error.message)) failure.reason = error.message;
      throw failure;
    }
    return data;
  } finally { clearTimeout(timeout); }
}
