// 字幕列：在畫面最上方疊一條 DOM overlay，說明這一步在做什麼；交易送出後顯示 tx hash
// 與 BaseScan 連結。
//
// overlay 掛在 document.documentElement 上、pointer-events: none，不會擋到點擊。
// 換頁會清掉 DOM，所以「目前字幕」記在 Node 端，每次 load 事件後自動重畫。

export const BASESCAN_TX = 'https://sepolia.basescan.org/tx/';

const OVERLAY_ID = '__pepe_poc_caption';

function render({ step, total, caption, txHash, note }) {
  let el = document.getElementById('__pepe_poc_caption');
  if (!el) {
    el = document.createElement('div');
    el.id = '__pepe_poc_caption';
    el.setAttribute('aria-hidden', 'true');
    // 畫面底部置中的字幕條：不蓋頁首（錢包地址、網路徽章）與左側導覽
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '28px',
      left: '50%',
      transform: 'translateX(-50%)',
      width: 'max-content',
      maxWidth: '82vw',
      borderRadius: '14px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      padding: '14px 30px',
      background: 'rgba(12, 17, 29, 0.84)',
      color: '#fff',
      fontFamily: '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif',
      boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
      border: '1px solid rgba(34, 197, 94, 0.55)',
      borderBottom: '3px solid #22c55e',
      textAlign: 'center',
      transition: 'opacity 200ms ease-out',
    });
    document.documentElement.appendChild(el);
  }
  el.innerHTML = '';

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' });

  const badge = document.createElement('span');
  badge.textContent = total ? `步驟 ${step}/${total}` : `步驟 ${step}`;
  Object.assign(badge.style, {
    flex: '0 0 auto', fontSize: '18px', fontWeight: '700', padding: '4px 12px',
    borderRadius: '999px', background: '#22c55e', color: '#052e16',
  });

  const text = document.createElement('span');
  text.textContent = caption;
  Object.assign(text.style, { fontSize: '24px', fontWeight: '600', lineHeight: '1.35', textAlign: 'left' });

  row.append(badge, text);
  el.append(row);

  if (txHash || note) {
    const sub = document.createElement('div');
    Object.assign(sub.style, { marginTop: '6px', fontSize: '16px', color: '#bbf7d0', fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all' });
    sub.textContent = txHash ? `tx ${txHash}\nhttps://sepolia.basescan.org/tx/${txHash}` : note;
    sub.style.whiteSpace = 'pre-line';
    el.append(sub);
  }
}

export function createOverlay(page) {
  let state = null;

  async function apply() {
    if (!state) return;
    try {
      await page.evaluate(render, state);
    } catch {
      // 換頁途中 evaluate 會失敗；load 事件後會再畫一次
    }
  }

  page.on('load', () => { void apply(); });

  return {
    /** 每步開始前呼叫：顯示字幕。 */
    async caption(step, total, caption, note) {
      state = { step, total, caption, note, txHash: null };
      await apply();
    },
    /** 交易送出後呼叫：字幕列第二行顯示 tx hash 與 BaseScan 連結。 */
    async tx(txHash) {
      state = { ...state, txHash };
      await apply();
    },
    async note(note) {
      state = { ...state, note };
      await apply();
    },
    reapply: apply,
    id: OVERLAY_ID,
  };
}
