# 進度表：風險模型＋Besu 部署計畫

> 狀態：`完成`／`進行中`／`待開始`。Phase 1–4 的子項是依計畫名稱先列的草稿，開工時依任務書修正。
> 原則：修改既有合約不新增方法；`PerpetualExchange` 大小預算餘裕 0 B（見 [`PARAMS_INVENTORY.md`](PARAMS_INVENTORY.md) §8）。

| Phase | 子項 | 狀態 | 產出檔 | 日期 |
|---|---|---|---|---|
| 0 | 0.1 槓桿、IMR／MMR、清算不等式與清算價封閉式 | 完成 | `docs/PARAMS_INVENTORY.md` §1 | 2026-10-05 |
| 0 | 0.2 資金費率（`_pokeFunding`／`settleFunding`）與借貸費 | 完成 | `docs/PARAMS_INVENTORY.md` §2 | 2026-10-05 |
| 0 | 0.3 Oracle 介面、maxPriceAge（原始碼與鏈上）、GuardedOracle、keeper 實際推價間隔 | 完成 | `docs/PARAMS_INVENTORY.md` §3 | 2026-10-05 |
| 0 | 0.4 清算流程、獎勵分配、壞帳瀑布、保險庫資金來源 | 完成 | `docs/PARAMS_INVENTORY.md` §4 | 2026-10-05 |
| 0 | 0.5 抵押品、對手方、OI 上限 | 完成 | `docs/PARAMS_INVENTORY.md` §5 | 2026-10-05 |
| 0 | 0.6 測試框架、測試數量、覆蓋推估 | 完成 | `docs/PARAMS_INVENTORY.md` §6 | 2026-10-05 |
| 0 | 0.7 任務書假設 vs 程式實際 | 完成 | `docs/PARAMS_INVENTORY.md` §7 | 2026-10-05 |
| 0 | 0.8 constant／setter／部署參數清單 | 完成 | `docs/PARAMS_INVENTORY.md` §8 | 2026-10-05 |
| 1 | 1-1 價格過程與校準：GBM、Merton；Binance 1h（BTC、ETH）、Yahoo 1d（AAPL、TSLA）快取；門檻法為主、MLE 對照 | 完成 | `risk_model/calibration.py`、`docs/RISK_MODEL.md` 第二部 §1 | 2026-10-05 |
| 1 | 1-2 清算價（程式線性式 vs 任務書分式）、首次穿越封閉解（多／空）、MC 驗證、L×σ 熱圖 | 完成 | `risk_model/liquidation.py`、§2 | 2026-10-05 |
| 1 | 1-3 跳空壞帳：推價間隔 × 清算人反應 × maxPriceAge 分開參數化；E／VaR／ES／P(>0)；陳舊價套利 | 完成 | `risk_model/gap_risk.py`、§3 | 2026-10-05 |
| 1 | 1-4 保險庫償付：程式實際收入、年破產機率、Lundberg、敏感度、ADL 反事實 | 完成 | `risk_model/insurance.py`、§4 | 2026-10-05 |
| 1 | 1-5 資金費率：OI 失衡 X 的 OU 回復、半衰期、8h 快照 vs 每區塊、快照狙擊 | 完成 | `risk_model/funding.py`、§5 | 2026-10-05 |
| 1 | 1-6 參數反推與公鏈版建議參數表 | 完成 | `risk_model/inverse.py`、§6 | 2026-10-05 |
| 2 | 2.1 模擬／壓力測試（價格跳空、壞帳瀑布、ADL） | 待開始 | — | — |
| 2 | 2.2 以 Foundry 測試對照封閉式（只加測試，不改合約） | 待開始 | — | — |
| 3 | 3.1 Besu 網路設定（hard fork／evm_version、contractSizeLimit） | 待開始 | — | — |
| 3 | 3.2 以 `DeployTenant.s.sol`＋租戶設定部署到 Besu | 待開始 | — | — |
| 3 | 3.3 Besu 上的 keeper 與清算 bot | 待開始 | — | — |
| 4 | 4.1 部署驗收（鏈上＝原始碼、參數核對） | 待開始 | — | — |
| 4 | 4.2 文件與交接 | 待開始 | — | — |

Phase 1 關鍵數字（完整模式 `risk_model/run_all.py`，種子 20261005；保險庫假設為 OI 的 5%）：

- 封閉解 vs MC（bridge）：8 組情境 |z| ≤ 1.28；程式整數不等式與線性封閉式 20,000 點一致（邊界 10⁻⁹ 內 2 點除外）。
- 24h 清算機率（Low 5x、GBM）：σ = 80%／100%／150% → 0.013%／0.22%／4.3%；ETH 5x 含跳躍 0.010%（GBM 0.0002%）。
- sETH 5x 帳簿單日壞帳（現況）：期望 0.17 bps of OI、P(>0) 1.6%、VaR₉₉ 1.7 bps、ES₉₉ 16 bps；改善基礎設施後 ES₉₉ 11.5 bps。
- 年破產 < 0.1% 所需保險庫：sETH 5x 3.5% of OI（改善後 2.2%）、sAAPL 5x 11.8%（不可行，建議 4x＋MMR 10%）、sBTC／sTSLA（1x）≈ 0–1.4%。
- 陳舊價套利：10 bps 手續費的資產損益兩平陳舊時間約 7–8 分鐘；實測 90 分鐘推價下每筆期望優勢約 44–49 bps of 名目。
- 資金費快照制可被狙擊：X = 0.5 時收方淨賺 0.91%／次（Low）；持有型套利 θ = 20 時半衰期約 37 小時。
