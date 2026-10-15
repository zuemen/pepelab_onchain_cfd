// 回放與展示用價格寫入共用的本機鏈 provider。兩邊都在 automine 的 Anvil 上一筆接一筆送交易，
// 設定不同就會一邊正常、一邊壞掉（展示用的 priceTick 曾因為用了預設值而 nonce too low）。
import { ethers } from "ethers";

export const LOCAL = ethers.Network.from(31337);

/**
 * 固定網路、不批次、不快取。
 * - cacheTimeout: -1：ethers 預設把 250ms 內相同的請求併成一次。Anvil 即時出塊、收據每 50ms
 *   輪詢一次，上一筆上鏈後的下一筆常落在這 250ms 內，查到的是舊 nonce → nonce too low。
 * - batchMaxCount: 1：預設的 10ms 批次等待會讓幾萬筆依序送出的交易慢上好幾倍。
 */
export const localProvider = (rpc: string): ethers.JsonRpcProvider =>
  new ethers.JsonRpcProvider(rpc, LOCAL, {
    staticNetwork: LOCAL, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 100,
  });
