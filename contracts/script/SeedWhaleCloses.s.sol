// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/PerpetualExchange.sol";

/// @notice Tops up and then CLOSES positions for the demo whales seeded by
///         SeedWhales.s.sol, so they clear the leaderboard's "at least 5 closed
///         trades" bar and the marketplace podium stops being empty.
///
///         Run with (Base Sepolia):
///   source contracts/.env.base-sepolia.local
///   forge script script/SeedWhaleCloses.s.sol \
///     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow -vv
///
///   Required env: EXCHANGE_ADDR, USDC_ADDR, SEED_MNEMONIC
///   Optional env: WHALE_INDICES (default 3,6,9 - ESG Master / Tesla Maxi /
///                 Macro Trader), MIN_CLOSES (default 5), MARGIN_WEI
///                 (default 50e18), ORACLE_ADDR + ORACLE_OWNER_PK (see
///                 "Why the price nudge").
///
/// @dev Three things about this script are load-bearing:
///
///      **The whale keys come from SEED_MNEMONIC, not from the deployer.**
///      `closePosition` reverts `NotPositionOwner` for anyone but the position
///      owner (PerpetualExchange._closePosition), and the whales are
///      `vm.deriveKey(SEED_MNEMONIC, i + 1)` - the same derivation
///      SeedWhales.s.sol used, so indices 3 / 6 / 9 are ESG Master / Tesla Maxi
///      / Macro Trader. Without the exact phrase that seeded the chain the
///      derived addresses are strangers holding nothing; the loop says so and
///      skips rather than failing obscurely.
///
///      **No mint, so no MockUSDC owner key needed.** The whales were each
///      minted 20,000 USDC at seed time and still hold ~14k-18k. Topping up
///      margin moves their own balance, so the only signers here are the whales
///      themselves. (MockUSDC ownership has since been rotated away from the
///      original deployer anyway.)
///
///      **Why the price nudge.** Opening and closing at the same index price
///      loses the trading fee every time - five closes, five losses, a 0% win
///      rate on the podium. Given ORACLE_ADDR and ORACLE_OWNER_PK the script
///      moves the mark between the two halves of the batch, so longs close into
///      a rally and shorts into the pullback: a mixed record instead of a
///      uniformly red one. It is optional because the oracle owner is a third
///      key that whoever runs this may not hold.
contract SeedWhaleCloses is Script {
    bytes32 constant SBTC = keccak256("sBTC");
    bytes32 constant SETH = keccak256("sETH");

    /// @dev Same guard as SeedWhales: falling back to the Anvil phrase is fine
    ///      locally and catastrophic on a public chain (sweeper bots own those
    ///      addresses), so a public run without the variable fails loudly.
    function seedMnemonic() internal view returns (string memory m) {
        m = vm.envOr("SEED_MNEMONIC", string(""));
        if (bytes(m).length == 0) {
            require(
                block.chainid == 31337,
                "SEED_MNEMONIC unset. Public chains need the phrase that seeded them."
            );
            m = "test test test test test test test test test test test junk";
        }
    }

    function defaultIndices() internal pure returns (uint256[] memory idx) {
        idx = new uint256[](3);
        idx[0] = 3; // ESG Master
        idx[1] = 6; // Tesla Maxi
        idx[2] = 9; // Macro Trader
    }

    function run() external {
        address exchangeAddr = vm.envAddress("EXCHANGE_ADDR");
        address usdcAddr     = vm.envAddress("USDC_ADDR");

        uint256 target = vm.envOr("MIN_CLOSES", uint256(5));
        uint256 margin = vm.envOr("MARGIN_WEI", uint256(50e18));
        uint256[] memory indices = vm.envOr("WHALE_INDICES", ",", defaultIndices());

        PerpetualExchange exchange = PerpetualExchange(exchangeAddr);
        MockUSDC          usdc     = MockUSDC(usdcAddr);
        uint256           execFee  = exchange.executionFee();
        string memory     phrase   = seedMnemonic();

        require(margin >= exchange.MIN_MARGIN(), "MARGIN_WEI below MIN_MARGIN");

        for (uint256 n = 0; n < indices.length; n++) {
            uint256 pk     = vm.deriveKey(phrase, uint32(indices[n]));
            address trader = vm.addr(pk);

            console.log("--- whale index", indices[n]);
            console.log("    address", trader);

            uint256[] memory existing = exchange.getUserPositions(trader);
            console.log("    positions listed on chain:", existing.length);

            // Nothing derived here belongs to the chain we are pointing at -
            // almost always the wrong SEED_MNEMONIC. Say so instead of
            // broadcasting a deposit into an address nobody controls.
            if (existing.length == 0 && usdc.balanceOf(trader) == 0 && trader.balance == 0) {
                console.log("    SKIPPED: empty address - wrong SEED_MNEMONIC?");
                continue;
            }

            // 先關掉「目前列出來的」部位,並**數成功幾筆**——不能拿
            // getUserPositions().length 當「未平倉數」。線上 0xEf75… 那版比
            // src/ 舊,它的 getUserPositions 是 append-only(平倉不會從陣列移
            // 除,實測 55/56 平掉之後仍然列在裡面)。照長度算 need,第二次跑就
            // 會算出 need=0,然後對五筆已平倉的 id 再送五筆必然 revert 的交易,
            // 一筆新的平倉都不會產生。數「成功」而不是數「長度」,兩個版本的
            // 合約都對。
            _nudge(true);

            uint256 closed = 0;
            vm.startBroadcast(pk);
            for (uint256 k = 0; k < existing.length; k++) {
                if (_close(exchange, existing[k])) closed++;
            }
            vm.stopBroadcast();
            console.log("    closed from existing:", closed);

            uint256 need = target > closed ? target - closed : 0;

            if (need > 0) {
                vm.startBroadcast(pk);
                {
                    uint256 required = need * margin;
                    uint256 free     = exchange.freeMargin(trader);
                    if (free < required) {
                        uint256 gap = required - free;
                        usdc.approve(exchangeAddr, gap);
                        exchange.depositMargin(gap);
                        console.log("    deposited extra margin:", gap);
                    }
                    // 多空交錯,配合下面的反向調價,大約一半會是獲利平倉。
                    for (uint256 k = 0; k < need; k++) {
                        bool    isLong = (k % 2 == 0);
                        bytes32 asset  = (k % 4 < 2) ? SBTC : SETH;
                        try exchange.openPosition{value: execFee}(asset, isLong, margin, 1) {
                            console.log("    opened", k + 1);
                        } catch (bytes memory reason) {
                            console.log("    open skipped");
                            console.logBytes(reason);
                        }
                    }
                }
                vm.stopBroadcast();

                _nudge(false);

                // 新開的一定排在陣列尾端,兩種合約版本皆然:swap-pop 版此時陣列
                // 只剩新的這幾筆,append-only 版則是舊的在前、新的在後。取尾端
                // need 筆,不用管前面那些已經平掉的。
                uint256[] memory after_ = exchange.getUserPositions(trader);
                uint256 start = after_.length > need ? after_.length - need : 0;

                vm.startBroadcast(pk);
                for (uint256 k = start; k < after_.length; k++) {
                    if (_close(exchange, after_[k])) closed++;
                }
                vm.stopBroadcast();
            }

            console.log("    closes landed this run:", closed);
        }

        console.log("Done. Reload /marketplace - the podium needs >= 5 closes per trader.");
    }

    /// @dev Returns whether the close actually landed. Already-closed ids
    ///      revert PositionAlreadyClosed and are expected on a re-run, so they
    ///      are counted as "not landed" rather than aborting the batch.
    function _close(PerpetualExchange exchange, uint256 id) internal returns (bool) {
        try exchange.closePosition(id) {
            console.log("    closed position", id);
            return true;
        } catch {
            console.log("    already closed / not closable:", id);
            return false;
        }
    }

    /// @dev Moves sBTC/sETH by +/-2% so the two halves of the batch do not both
    ///      settle at the entry price. No-op unless the oracle owner key is
    ///      supplied - an unsigned nudge would revert OwnableUnauthorizedAccount
    ///      and take the whole run down with it.
    function _nudge(bool up) internal {
        address oracleAddr = vm.envOr("ORACLE_ADDR", address(0));
        uint256 ownerPk    = vm.envOr("ORACLE_OWNER_PK", uint256(0));
        if (oracleAddr == address(0) || ownerPk == 0) return;

        MockOracle oracle = MockOracle(oracleAddr);
        bytes32[2] memory assets = [SBTC, SETH];

        vm.startBroadcast(ownerPk);
        for (uint256 i = 0; i < assets.length; i++) {
            (uint256 price,) = oracle.getPrice(assets[i]);
            uint256 moved = up ? price * 102 / 100 : price * 98 / 100;
            try oracle.updatePrice(assets[i], moved) {
                console.log("    oracle nudged to", moved);
            } catch {
                console.log("    oracle nudge failed - is ORACLE_OWNER_PK the owner?");
            }
        }
        vm.stopBroadcast();
    }
}
