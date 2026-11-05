// 新聞ツールを shift.workchat.neltec-tokyo.info でも開けるようにする中継(2026-11-05)。
// パスキーは NexPort の RP ID(workchat.neltec-tokyo.info)の配下でしか動かないため。
// 画面の正は GitHub Pages のまま(git push で両方のアドレスに反映)。旧アドレスは変えず、新旧を並行して動かす。
// やめるときはこの Worker を止めるだけでよい。
const ORIGIN = 'https://neltecsystem-tech.github.io/shift-manager';

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    // Cookie などは Pages に渡さない。キャッシュの確認に要るものだけ送る
    const headers = new Headers();
    for (const name of ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since']) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    return fetch(ORIGIN + url.pathname + url.search, { method: request.method, headers, redirect: 'follow' });
  },
};
