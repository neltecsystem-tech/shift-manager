import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// TinyURL は CORS を返さないので EF 経由でプロキシ。
// 1コースあたり数本の長い Google Maps ナビ URL を短縮するため。
async function shortenOne(url: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': 'shift-manager-shorten/1.0' },
    });
    const text = (await resp.text()).trim();
    if (resp.ok && text.startsWith('http')) return text;
    return null;
  } catch (_e) {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const urls: string[] = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);
    if (urls.length === 0) {
      return new Response(JSON.stringify({ error: 'urls (or url) required' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }
    if (urls.length > 50) {
      return new Response(JSON.stringify({ error: 'too many urls (max 50)' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }
    const results = await Promise.all(urls.map(shortenOne));
    return new Response(JSON.stringify({ results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
