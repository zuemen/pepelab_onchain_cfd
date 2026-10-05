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
| 1 | 1-1 價格過程與校準：GBM、Merton；Binance 1h（BTC、ETH）、Yahoo 1d（AAPL、TSLA）（原始價格不進版控，只 commit 校準參數）；門檻法為主、MLE 對照 | 完成 | `risk_model/calibration.py`、`docs/RISK_MODEL_CFD.md` §1 | 2026-10-05 |
| 1 | 1-2 清算價（程式線性式 vs 任務書分式）、首次穿越封閉解（多／空）、MC 驗證、L×σ 熱圖 | 完成 | `risk_model/liquidation.py`、§2 | 2026-10-05 |
| 1 | 1-3 跳空壞帳：推價間隔 × 清算人反應 × maxPriceAge 分開參數化；E／VaR／ES／P(>0)；價格時效風險 | 完成 | `risk_model/gap_risk.py`、§3 | 2026-10-05 |
| 1 | 1-4 保險庫償付：程式實際收入、年破產機率、Lundberg、敏感度、ADL 反事實 | 完成 | `risk_model/insurance.py`、§4 | 2026-10-05 |
| 1 | 1-5 資金費率：OI 失衡 X 的 OU 回復、半衰期、8h 快照 vs 每區塊、快照結算風險 | 完成 | `risk_model/funding.py`、§5 | 2026-10-05 |
| 1 | 1-6 參數反推與公鏈版建議參數表 | 完成 | `risk_model/inverse.py`、§6 | 2026-10-05 |
| 2 | 2.1 模擬／壓力測試（價格跳空、壞帳瀑布、ADL） | 待開始 | — | — |
| 2 | 2.2 以 Foundry 測試對照封閉式（只加測試，不改合約） | 待開始 | — | — |
| 3 | 3.1 最終性（QBFT 不重組）與 Δ = max(出塊, 推價) 的壞帳收斂 | 完成 | `risk_model/besu.py`、`docs/BESU_CALIBRATION.md` §1 | 2026-10-05 |
| 3 | 3.2 許可制 keeper 的 SLA 模型（延遲分布、p99、停擺） | 完成 | `besu.py`、§2 | 2026-10-05 |
| 3 | 3.3 Oracle 停擺（時長分布、maxPriceAge 擋交易、恢復跳空）與 maxPriceAge／推價間隔建議 | 完成 | `besu.py`、§3、§4 | 2026-10-05 |
| 3 | 3.4 逐資產槓桿與 MMR 反推（Besu 基準情境）、清算人 0%／保險庫分配 | 完成 | `run_besu.py`、§5、§6 | 2026-10-05 |
| 3 | 3.5 資金費累積間隔（快照錯配、整數 bps 死區、補算 21 區間的 keeper 要求） | 完成 | `besu.py`、§7 | 2026-10-05 |
| 3 | 3.6 機構 VaR／ES（多資產、相關性）與歷史壓力測試 | 完成 | `risk_model/besu_institution.py`、`risk_model/data/besu_market_stats.json`、§8、§9 | 2026-10-05 |
| 3 | 3.7 Besu 版建議參數表（並列公鏈版）；setter 參數落地到 `besu/config/risk-params.besu.json`＋`besu/scripts/apply-risk-params.mjs`；constant 只寫建議 | 完成 | §10、§11 | 2026-10-05 |
| 4 | 4.1 架構：鏈下風險引擎／鏈上 setter／風控＋法遵多簽＋timelock、QBFT 驗證者、許可制 | 完成（設計） | `docs/DESIGN_BESU.md` §1 | 2026-10-05 |
| 4 | 4.2 隱私：Tessera 現況、承諾、ZK 保證金證明、privacy plugin 取捨 | 完成（設計） | `docs/DESIGN_BESU.md` §2 | 2026-10-05 |
| 4 | 4.3 身分准入：合格投資人 VC × 既有 `kyc()`／`rwaAsset` 閘門、撤銷（ADR-016） | 完成（設計） | `docs/DESIGN_BESU.md` §3 | 2026-10-05 |
| 4 | 4.4 結算資產：代幣化存款／穩定幣（對照 ADR-011） | 完成（設計） | `docs/DESIGN_BESU.md` §4 | 2026-10-05 |
| 4 | 4.5 監理定位（需法遵確認） | 完成（設計） | `docs/DESIGN_BESU.md` §5 | 2026-10-05 |
| 4 | 4.6 延伸研究：QAE 估計期望壞帳（只寫文字） | 完成（設計） | `docs/DESIGN_BESU.md` §6 | 2026-10-05 |
| 4 | 4.7 與 Phase 1–3 銜接（`RISK_MODEL_CFD.md`／`BESU_CALIBRATION.md` 章節回填） | 完成 | `docs/DESIGN_BESU.md` §7 | 2026-10-05 |

註：Phase 2 的實際產出是 `besu/`（Besu QBFT 網路、部署、推價、keeper、e2e、fork 測試；PR #261），上表 2.x 仍是開工前的草稿名稱，未在本次（Phase 3）更動。

Phase 1 關鍵數字（完整模式 `risk_model/run_all.py`，種子 20261005；保險庫假設為 OI 的 5%）：

- 封閉解 vs MC（bridge）：8 組情境 |z| ≤ 1.28；程式整數不等式（Python 重寫）與線性封閉式 20,000 點一致（邊界 10⁻⁹ 內 2 點除外）。
- 24h 清算機率（Low 5x、GBM）：σ = 80%／100%／150% → 0.013%／0.22%／4.3%；ETH 5x 含跳躍比 GBM 高 1–2 個數量級。
- sETH 5x 帳簿單日壞帳（現況）：期望 0.17 bps of OI、P(>0) 1.6%、VaR₉₉ 1.7 bps、ES₉₉ 16 bps；改善基礎設施後 ES₉₉ 11.5 bps。
- 年破產 < 0.1% 所需保險庫（同一批樣本，95% CI）：sETH 5x 3.4%（3.2–3.7%） of OI、sAAPL 5x 9.4%（9.0–10.1%，現值不可行，建議 4x＋MMR 10%）、sBTC／sTSLA（1x）< 1%。
- 價格時效：屬高風險，風險與 maxPriceAge、推價間隔同向增加；建議開倉可用的價格時效遠小於現值（`RISK_MODEL_CFD.md` §3.5）。
- 資金費：快照結算、持有時間不加權，屬中高風險，建議改為按持有時間累積（§5.4）；回復資金持續持有時，θ = 20 的半衰期約 37 小時。

Phase 3 關鍵數字（完整模式 `risk_model/run_besu.py`，種子 20261005；記憶體峰值 395 MB；詳見 [`BESU_CALIBRATION.md`](BESU_CALIBRATION.md)）：

- Δ 收斂：ETH 5x 每日期望壞帳 6 小時 0.156 → 2 秒 0.127 bps，Δ ≤ 1 分鐘後不再變（剩跳躍下限）；公鏈現況 0.166。
- keeper SLA：p99 延遲 ≤ 2 分鐘時壞帳與理想情況無差，1 小時多約 6–7%；停擺幾乎不影響壞帳。SLA 目標由營運決定：p99 ≤ 30 秒、月可用率 ≥ 99.9%、兩個實例。
- Oracle 停擺：單日 4 小時停擺只讓 ETH 壞帳多約 3%；maxPriceAge 對壞帳沒有影響。maxPriceAge 建議 60 秒（公鏈 6 小時）：最壞時效暴露約公鏈的 5%、誤擋約每年半小時。
- 槓桿／MMR（保險庫 5%；前提 `esgRegistry = 0`，碳定價停用的 PoC 部署）：BTC 5x／5%、ETH 5x／5%、AAPL 5x／15%（替代 3x／5%）、TSLA 1x／5%。租戶部署（碳分級啟用）新資產一律 Unrated＝1x，分級版本見 §5.2。
- 清算人 0%：`liquidatePosition` 無權限限制，白名單內任何帳戶都能清算拿 5%，不改合約時「實質 0%」只是上限（ETH 5x 保險庫需求 2.3%～2.05%）；保證 0% 需改 constant 或 Besu 交易層外掛。獎勵轉入保險庫須用 owner `recapitalize`（`deposit` 會鑄份額給 keeper）。
- 資金費：快照錯配比例 ∝ 累積間隔；整數 bps 下間隔 < 6.4 分鐘費率恆為 0，每區塊累積時補算窗只剩 42 秒——需改精度與補算上限（改合約，本 PR 不改）。
- 機構：均衡 1 日 VaR₉₉ 0.15%、ES₉₇.₅ 0.18% of OI；30% 失衡 VaR₉₉ ≈ 1.5–1.6%、10 日 ES₉₇.₅ ≈ 4.9%。最嚴重壓力 S1（2020-03-12 型）單日 19–21% of OI，一次跳空時壞帳最高約保險庫的 2.9 倍。

## 總結

建議參數表（公鏈版 vs Besu 版）與 Phase 0–4 的完整產出檔案清單，見 [`BESU_CALIBRATION.md`](BESU_CALIBRATION.md) §14。
