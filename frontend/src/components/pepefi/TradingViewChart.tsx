import { useRef, useEffect } from 'react';

import Box from '@mui/material/Box';

// ----------------------------------------------------------------------
// TradingView 的 Advanced Chart widget。
//
// 為什麼是「真的 TradingView」而不是站內自繪的 lightweight-charts：專業終端那張
// K 線是我們自己畫的（資料來自 signal-api /candles，加密貨幣首選 Coinbase 現貨），
// 而教授的回饋指名「加密貨幣的 TradingView 畫面建議用 Coinbase 的 BTC Spot USD
// 報價為準」。資料來源已經照做，但畫面不是 TradingView 的畫面；這個元件把後半
// 也補上，預設 symbol 就是 `COINBASE:BTCUSD`——Coinbase 現貨，不是永續。
//
// 這是唯一一個對外部網域有執行期依賴的元件。腳本載不到時 widget 的容器會是空的，
// 所以外層要自己交代「這是外部圖表」，不要讓一塊空白看起來像壞掉的頁面。

export interface TradingViewChartProps {
  /** TradingView 的 symbol，例如 `COINBASE:BTCUSD`。 */
  symbol: string;
  /** 容器高度（px）。 */
  height?: number;
  /**
   * 預設時間範圍。issue #100 ④：資產頁用「投資的時間尺度」開場，而不是「交易的」
   * ——所以預設一年，不是內建的當日。可接受的值同 TradingView：`1D` `1M` `12M`
   * `60M` `ALL` 等。
   */
  range?: string;
}

const SCRIPT_SRC = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

export default function TradingViewChart({ symbol, height = 420, range = '12M' }: TradingViewChartProps) {
  const holder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = holder.current;
    if (!node) return undefined;

    // widget 的設定是**寫在 script 標籤的 textContent 裡**的（TradingView 的
    // embed 約定），不是呼叫某個 API。所以換 symbol 只能整塊重建，不能就地更新。
    node.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.height = '100%';

    const target = document.createElement('div');
    target.className = 'tradingview-widget-container__widget';
    target.style.height = '100%';
    container.appendChild(target);

    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.type = 'text/javascript';
    script.innerHTML = JSON.stringify({
      symbol,
      autosize: true,
      interval: 'D',
      range,
      timezone: 'Asia/Taipei',
      theme: 'dark',
      style: '1',
      locale: 'zh_TW',
      hide_side_toolbar: true,
      allow_symbol_change: false,
      save_image: false,
      // 這個 widget 不接受 API key，也不會拿到我們的任何資料——它只知道 symbol。
      support_host: 'https://www.tradingview.com',
    });
    container.appendChild(script);
    node.appendChild(container);

    // StrictMode 會把 effect 跑兩次；不清乾淨就會疊出兩張圖。
    return () => {
      node.innerHTML = '';
    };
  }, [symbol]);

  return <Box ref={holder} sx={{ height, width: '100%' }} />;
}
