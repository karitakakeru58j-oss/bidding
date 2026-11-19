// DDS（ダブルダミー・ソルバー）の呼び出し：ページ（vendor/dds.js を読み込んだ後）と Node（@bridge-tools/dd の wasm）で共通
//   solve(deal, trick, toPlay, trump) → toPlay 側が取れる残りのトリック数
//   deal = { N:[{suit,rank}], ... }（すでにプレイしたカードは除く）、trick＝今のトリックに出たカード（0〜3枚）
(function (root) {
  const SUIT = { S: 0, H: 1, D: 2, C: 3 }, TRUMP = { S: 0, H: 1, D: 2, C: 3, NT: 4 };
  const RANK = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
  const SEATS = ['N', 'E', 'S', 'W'], ORDER = 'AKQJT98765432';
  let inst = null, loading = null;
  function factory() {
    if (typeof module !== 'undefined' && module.exports) return require('./vendor/dds.js');
    return root.create_dds_module;
  }
  async function instance() {
    if (inst) return inst;
    if (!loading) loading = (async () => {
      const node = typeof module !== 'undefined' && module.exports;
      const m = await factory()({ locateFile: p => node ? require('path').join(__dirname, 'vendor', p) : (root.DDS_BASE || '') + p, print: () => {}, printErr: () => {} });
      m._dds_init(); inst = m; return m;
    })();
    return loading;
  }
  const handStr = cards => ['S', 'H', 'D', 'C'].map(s => cards.filter(c => c.suit === s).map(c => c.rank).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).join('')).join('.');
  async function solve(deal, trick, toPlay, trump) {
    const m = await instance();
    const str = 'N:' + SEATS.map(s => handStr(deal[s])).join(' ');
    const dp = m.allocateUTF8(str);
    const rp = m._malloc(13 * 3 * 4);
    for (let i = 0; i < 13; i++) m.setValue(rp + i * 4, -1, 'i32');
    const c = i => trick[i] ? [SUIT[trick[i].suit], RANK[trick[i].rank]] : [0, 0];
    const first = SEATS[(SEATS.indexOf(toPlay) - trick.length + 8) % 4];
    m._dds_solve_board(TRUMP[trump], SEATS.indexOf(first), ...c(0), ...c(1), ...c(2), dp, rp);
    let best = 0;
    for (let i = 0; i < 13; i++) {
      const at = rp + i * 12, rank = m.getValue(at, 'i32');
      if (rank === -1 || rank === 0) break;
      best = Math.max(best, m.getValue(at + 8, 'i32'));
    }
    m._free(rp); m._free(dp);
    return best;
  }
  const api = { solve, instance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BridgeDDS = api;
})(typeof window !== 'undefined' ? window : globalThis);
