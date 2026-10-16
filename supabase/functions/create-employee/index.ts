import {createHandler} from './handler.mjs';

// Secrets exist only in the Edge Function environment, never in config.js.
Deno.serve(createHandler({
  url: Deno.env.get('SUPABASE_URL'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  origin: Deno.env.get('ROOMLY_ORIGIN') || 'https://rafwonko-stack.github.io',
}));
