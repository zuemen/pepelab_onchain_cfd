// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PepeAMM.sol";
import "../src/PepeToken.sol";
import "../src/PepeStaking.sol";
import "../src/PepeIncentives.sol";
import "../src/MockUSDC.sol";
import "../src/MockUSDT.sol";
import "../src/MockOracle.sol";
import "../src/MockSwapRouter.sol";
import "../src/ESGRegistry.sol";
import "../src/KYCRegistry.sol";
import "../src/PepeClaim.sol";
import "../src/ChainlinkOracleAdapter.sol";
import "../src/PythOracleAdapter.sol";
import "../src/AggregatorOracleAdapter.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/v2/AssetVaultV2_2.sol";
import "../src/v2/SyntheticAssetV2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./MockAggregatorV3.sol";
import "./MockPyth.sol";

// ─────────────────────────────────────────────────────────────────────────────
// PA-1 / PA-2 / PA-5 — PepeAMM
// ─────────────────────────────────────────────────────────────────────────────

contract AuditPepeAMMTest is Test {
    MockUSDC   usdc;
    MockOracle oracle;
    PepeAMM    amm;

    address alice = makeAddr("alice");
    address lp    = makeAddr("lp");

    bytes32 constant ETH_ID = 0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9;

    // Mirrors the live Base Sepolia pool the audit PoC ran against.
    uint256 constant INIT_ETH  = 0.1 ether;
    uint256 constant INIT_USDC = 300e18;

    function setUp() public {
        vm.warp(1_000_000);
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(ETH_ID, 3_000e8);

        amm = new PepeAMM(address(usdc), address(oracle));

        usdc.mint(address(this), INIT_USDC);
        usdc.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: INIT_ETH}(INIT_USDC);

        vm.deal(alice, 100 ether);
        usdc.mint(alice, 100_000e18);
        vm.prank(alice); usdc.approve(address(amm), type(uint256).max);
    }

    // ── PA-1 ────────────────────────────────────────────────────────────────

    /// @dev THE PA-1 PoC. Old pricing: `amountIn * oraclePrice`, zero slippage.
    ///      Buy ETH out of the pool at the oracle price, wait for a 10% oracle
    ///      tick (an ordinary intraday move), sell it back at the new oracle
    ///      price, walk away with ~9% of the pool's USDC. Repeatable every tick
    ///      until the reserves are gone, because with no slippage the arbitrage
    ///      never pushes the quote back.
    ///
    ///      Under `x*y=k` the same sequence is a LOSS for the attacker: the
    ///      first leg moves the pool price against him, so the second leg fills
    ///      worse, and both legs pay the fee.
    function test_PA1_oracleTickRoundTripIsNoLongerFreeMoney() public {
        uint256 usdcIn = 20e18;                  // ~7% of the pool's USDC

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        uint256 ethOut = amm.swapUSDCForETH(usdcIn, 0);
        assertEq(alice.balance - ethBefore, ethOut);

        // Oracle ticks +10%. Under the old contract this was the entire attack.
        oracle.updatePrice(ETH_ID, 3_300e8);

        vm.prank(alice);
        uint256 usdcBack = amm.swapETHForUSDC{value: ethOut}(0);

        assertLt(usdcBack, usdcIn, "round trip must cost the attacker, not pay him");
        // The pool ends up with at least as much value as it started with.
        (uint256 ethR, uint256 usdcR) = amm.getReserves();
        assertGe(ethR * usdcR, INIT_ETH * INIT_USDC, "k never decreases");
    }

    /// @dev Slippage exists at all: a big trade fills materially worse than a
    ///      small one. Under oracle pricing both filled at exactly the same
    ///      rate, which is what made the drain possible.
    function test_PA1_largeTradeFillsWorseThanSmallTrade() public {
        uint256 small = 0.001 ether;
        uint256 large = 0.05 ether;

        uint256 rateSmall = amm.quoteETHForUSDC(small) * 1e18 / small;
        uint256 rateLarge = amm.quoteETHForUSDC(large) * 1e18 / large;

        assertLt(rateLarge, rateSmall, "constant product must price size");
    }

    function test_PA1_kIsPreservedAcrossManySwaps() public {
        uint256 kBefore = amm.ethReserve() * amm.usdcReserve();
        for (uint256 i; i < 5; i++) {
            vm.prank(alice);
            amm.swapETHForUSDC{value: 0.002 ether}(0);
            vm.prank(alice);
            amm.swapUSDCForETH(5e18, 0);
        }
        assertGe(amm.ethReserve() * amm.usdcReserve(), kBefore, "fees only add to k");
    }

    // ── PA-2 ────────────────────────────────────────────────────────────────

    /// @dev The only path in the whole system with no staleness check. Stop the
    ///      keeper and the pool kept quoting off a frozen price forever.
    function test_PA2_staleOracleBlocksSwaps() public {
        vm.warp(block.timestamp + 2 hours);   // past maxOracleAge (1h)

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PepeAMM.StaleOraclePrice.selector, block.timestamp - 2 hours, uint256(1 hours)
            )
        );
        amm.swapETHForUSDC{value: 0.001 ether}(0);

        vm.prank(alice);
        vm.expectRevert();
        amm.swapUSDCForETH(1e18, 0);
    }

    function test_PA2_refreshingTheOracleUnblocksSwaps() public {
        vm.warp(block.timestamp + 2 hours);
        oracle.updatePrice(ETH_ID, 3_000e8);      // keeper comes back
        vm.prank(alice);
        amm.swapETHForUSDC{value: 0.001 ether}(0);
    }

    function test_PA2_maxOracleAgeIsBounded() public {
        vm.expectRevert(PepeAMM.InvalidParam.selector);
        amm.setMaxOracleAge(30);                  // below MIN_ORACLE_AGE
        vm.expectRevert(PepeAMM.InvalidParam.selector);
        amm.setMaxOracleAge(2 days);              // above MAX_ORACLE_AGE
        amm.setMaxOracleAge(15 minutes);
        assertEq(amm.maxOracleAge(), 15 minutes);
    }

    // ── Oracle sanity band ──────────────────────────────────────────────────

    /// @dev A whale cannot park the pool at an absurd price between ticks…
    function test_band_swapPushingPoolFarOffOracleIsRejected() public {
        vm.prank(alice);
        vm.expectRevert();                        // PriceOutOfBand
        amm.swapETHForUSDC{value: 1 ether}(0);    // 10x the pool's ETH
    }

    /// @dev …but arbitrage BACK toward the oracle is always allowed, otherwise
    ///      the band would be a deadlock once the pool drifted out of it.
    function test_band_tradesThatRestoreAlignmentAreAllowed() public {
        // Push the pool out of band by moving the oracle instead of the pool.
        oracle.updatePrice(ETH_ID, 6_000e8);      // pool at 3000, oracle at 6000
        assertGt(amm.currentDeviationBps(), amm.maxOracleDeviationBps());

        uint256 devBefore = amm.currentDeviationBps();
        vm.prank(alice);
        amm.swapUSDCForETH(50e18, 0);             // buying ETH raises pool price
        assertLt(amm.currentDeviationBps(), devBefore, "converging trades go through");
    }

    // ── PA-5 ────────────────────────────────────────────────────────────────

    /// @dev Liquidity used to be a one-way door: no removeLiquidity at all, so
    ///      the seeded 0.1 ETH / 300 mUSDC was locked forever — even the owner
    ///      could not recover it.
    function test_PA5_liquidityCanBeWithdrawn() public {
        uint256 shares = amm.sharesOf(address(this));
        assertGt(shares, 0);

        uint256 ethBefore  = address(this).balance;
        uint256 usdcBefore = usdc.balanceOf(address(this));

        (uint256 ethOut, uint256 usdcOut) = amm.removeLiquidity(shares, 0, 0);

        assertGt(ethOut, 0);
        assertGt(usdcOut, 0);
        assertEq(address(this).balance - ethBefore, ethOut);
        assertEq(usdc.balanceOf(address(this)) - usdcBefore, usdcOut);
        assertEq(amm.sharesOf(address(this)), 0);
    }

    function test_PA5_lpSharesAreProportionalAndFeesAccrueToLps() public {
        // A second LP doubles the pool.
        vm.deal(lp, 1 ether);
        usdc.mint(lp, 10_000e18);
        vm.prank(lp); usdc.approve(address(amm), type(uint256).max);
        vm.prank(lp);
        uint256 lpShares = amm.addLiquidity{value: INIT_ETH}(1_000e18);

        assertApproxEqRel(lpShares, amm.sharesOf(address(this)), 1e15, "equal deposit, equal shares");

        // Trade back and forth so fees accumulate.
        for (uint256 i; i < 4; i++) {
            vm.prank(alice); amm.swapETHForUSDC{value: 0.002 ether}(0);
            vm.prank(alice); amm.swapUSDCForETH(5e18, 0);
        }

        uint256 ethBefore  = lp.balance;
        uint256 usdcBefore = usdc.balanceOf(lp);
        vm.prank(lp);
        (uint256 ethOut, uint256 usdcOut) = amm.removeLiquidity(lpShares, 0, 0);
        assertEq(lp.balance - ethBefore, ethOut);
        assertEq(usdc.balanceOf(lp) - usdcBefore, usdcOut);

        // Value out (marked at the oracle price) exceeds value in: the LP kept
        // its share of the fees.
        uint256 valueIn  = INIT_ETH * 3_000 + 300e18;
        uint256 valueOut = ethOut  * 3_000 + usdcOut;
        assertGt(valueOut, valueIn, "LP earns the fees");
    }

    function test_PA5_cannotRemoveMoreSharesThanOwned() public {
        vm.prank(alice);
        vm.expectRevert(PepeAMM.InsufficientShares.selector);
        amm.removeLiquidity(1, 0, 0);
    }

    function test_PA5_removeLiquidityHonoursMinimums() public {
        uint256 shares = amm.sharesOf(address(this));
        vm.expectRevert(PepeAMM.InsufficientOutput.selector);
        amm.removeLiquidity(shares, INIT_ETH + 1, 0);
    }

    // ── Low: receive() ──────────────────────────────────────────────────────

    /// @dev A bare `receive() {}` accepted ETH that was neither credited to
    ///      the reserves nor recoverable by anyone.
    function test_low_bareEthTransferIsRejected() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok, ) = address(amm).call{value: 1 ether}("");
        assertFalse(ok, "stray ETH must not be silently swallowed");
        assertEq(address(amm).balance, INIT_ETH);
    }

    // ── Slippage protection ─────────────────────────────────────────────────

    function test_minAmountOutIsEnforcedOnBothLegs() public {
        uint256 q1 = amm.quoteETHForUSDC(0.001 ether);
        vm.prank(alice);
        vm.expectRevert(PepeAMM.InsufficientOutput.selector);
        amm.swapETHForUSDC{value: 0.001 ether}(q1 + 1);

        uint256 q2 = amm.quoteUSDCForETH(1e18);
        vm.prank(alice);
        vm.expectRevert(PepeAMM.InsufficientOutput.selector);
        amm.swapUSDCForETH(1e18, q2 + 1);
    }

    receive() external payable {}
}

// ─────────────────────────────────────────────────────────────────────────────
// PA-3 / M9 — mock token supply side
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Deploys N children in its constructor, each of which claims the faucet.
///      This is the audit's M9 PoC: 50 claims in one transaction.
contract FaucetChild {
    constructor(address token) {
        (bool ok, ) = token.call(abi.encodeWithSignature("faucet()"));
        require(ok, "child faucet failed");
    }
}

contract FaucetLooper {
    function drain(address token, uint256 n) external {
        for (uint256 i; i < n; i++) new FaucetChild(token);
    }
}

contract AuditMockTokenTest is Test {
    MockUSDC       usdc;
    MockUSDT       usdt;
    PepeToken      pepe;
    MockSwapRouter router;

    address attacker = makeAddr("attacker");

    function setUp() public {
        usdc   = new MockUSDC();
        usdt   = new MockUSDT();
        pepe   = new PepeToken();
        router = new MockSwapRouter(address(usdc));
        usdc.setSwapRouter(address(router));
        router.fundRouter{value: 10 ether}();
    }

    /// @dev THE PA-3 PoC, verbatim: mint yourself 30,000 mUSDC, swap it for the
    ///      router's entire 10 ETH, at a cost of gas. The owner-only
    ///      `setSwapRouter` guard was pointless while the supply side was open.
    function test_PA3_freeMintDrainOfSwapRouterIsClosed() public {
        assertEq(address(router).balance, 10 ether);

        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.NotMinter.selector, attacker));
        usdc.mint(attacker, 30_000e18);
        vm.stopPrank();

        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(address(router).balance, 10 ether, "router keeps its ETH");
    }

    function test_PA3_usdtMintIsAlsoOwnerGated() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MockUSDT.NotMinter.selector, attacker));
        usdt.mint(attacker, 1e18);
    }

    /// @dev The router still works: it holds a mint right because its mint is
    ///      backed by ETH actually received at a fixed rate.
    function test_PA3_registeredRouterKeepsMintRights() public {
        address user = makeAddr("user");
        vm.deal(user, 1 ether);
        vm.prank(user);
        router.swapETHForUSDC{value: 1 ether}();
        assertEq(usdc.balanceOf(user), 3_000e18);
    }

    /// @dev M9: the per-address cooldown was bypassable by a contract that
    ///      deploys fresh addresses in a loop — 50 claims, one transaction.
    function test_M9_contractLoopCannotFarmTheFaucet() public {
        FaucetLooper looper = new FaucetLooper();

        vm.expectRevert();                       // child's faucet() reverts
        looper.drain(address(usdc), 50);
        assertEq(usdc.totalSupply(), 0, "not a single claim got through");

        vm.expectRevert();
        looper.drain(address(pepe), 50);
        assertEq(pepe.totalSupply(), pepe.INITIAL_SUPPLY());
    }

    function test_M9_eoaFaucetStillWorks() public {
        address eoa = makeAddr("eoa");
        vm.prank(eoa, eoa);
        usdc.faucet();
        assertEq(usdc.balanceOf(eoa), usdc.FAUCET_AMOUNT());

        vm.prank(eoa, eoa);
        pepe.faucet();
        assertEq(pepe.balanceOf(eoa), pepe.FAUCET_AMOUNT());

        vm.prank(eoa, eoa);
        usdt.faucet();
        assertEq(usdt.balanceOf(eoa), usdt.FAUCET_AMOUNT());
    }

    receive() external payable {}
}

// ─────────────────────────────────────────────────────────────────────────────
// PA-4 / M6 — PepeIncentives
// ─────────────────────────────────────────────────────────────────────────────

contract IncentivePepe {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract IncentiveExchange {
    struct Position {
        uint256 id; address owner; bytes32 asset; bool isLong;
        uint256 entryPrice; uint256 margin; uint256 leverage;
        uint256 openedAt; uint256 closedAt; int256 realizedPnL;
        bool isOpen; address copiedFrom; int256 entryFundingIndex;
    }
    mapping(uint256 => Position) public positions;

    function set(uint256 id, address owner_, uint256 margin, uint256 lev, bytes32 asset, uint256 openedAt, bool isOpen)
        external
    {
        positions[id] = Position(id, owner_, asset, true, 0, margin, lev, openedAt, 0, 0, isOpen, address(0), 0);
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return positions[id];
    }
}

contract IncentiveCopyTracker {
    struct CopyRecord {
        address trader; uint256 versionId; uint256 initialAmount;
        uint256[] positionIds; uint256 copiedAt; bool active;
    }
    mapping(address => CopyRecord[]) public records;

    function add(address follower, address trader) external {
        uint256[] memory ids;
        records[follower].push(CopyRecord(trader, 0, 0, ids, block.timestamp, true));
    }

    function getCopyRecords(address f) external view returns (CopyRecord[] memory) {
        return records[f];
    }
}

contract IncentiveEsg {
    mapping(bytes32 => uint8) public compositeScore;
    function set(bytes32 a, uint8 s) external { compositeScore[a] = s; }
}

contract AuditPepeIncentivesTest is Test {
    IncentivePepe        pepe;
    IncentiveExchange    exch;
    IncentiveCopyTracker copyT;
    IncentiveEsg         esg;
    PepeIncentives       inc;

    address alice = makeAddr("alice");
    bytes32 BTC   = keccak256("sBTC");

    function setUp() public {
        vm.warp(365 days);
        pepe  = new IncentivePepe();
        exch  = new IncentiveExchange();
        copyT = new IncentiveCopyTracker();
        esg   = new IncentiveEsg();
        inc   = new PepeIncentives(address(pepe), address(exch), address(copyT), address(esg));
        pepe.mint(address(inc), 1_000_000e18);
    }

    /// @dev THE PA-4 PoC: one 1,000-notional position listed 1,000 times summed
    ///      to 1,000,000 and cleared the Diamond tier outright — 50,000 PEPE
    ///      from a single trade.
    function test_PA4_duplicatePositionIdsCannotInflateTier() public {
        exch.set(1, alice, 200e18, 5, BTC, block.timestamp, true);   // 1,000 notional

        uint256[] memory ids = new uint256[](1_000);
        for (uint256 i; i < 1_000; i++) ids[i] = 1;

        vm.prank(alice);
        vm.expectRevert(PepeIncentives.PositionIdsNotSorted.selector);
        inc.claimTierReward(3, ids);
        assertEq(pepe.balanceOf(alice), 0);
    }

    /// @dev Not merely "no duplicates": the list must be strictly increasing, so
    ///      re-ordering cannot smuggle a repeat past a naive neighbour check.
    function test_PA4_unsortedListIsRejected() public {
        exch.set(1, alice, 2_000e18, 5, BTC, block.timestamp, true);
        exch.set(2, alice, 2_000e18, 5, BTC, block.timestamp, true);

        uint256[] memory ids = new uint256[](3);
        ids[0] = 2; ids[1] = 1; ids[2] = 2;

        vm.prank(alice);
        vm.expectRevert(PepeIncentives.PositionIdsNotSorted.selector);
        inc.claimTierReward(0, ids);
    }

    function test_PA4_honestSortedClaimStillWorks() public {
        exch.set(1, alice, 1_000e18, 5, BTC, block.timestamp, true);  // 5,000
        exch.set(2, alice, 1_000e18, 5, BTC, block.timestamp, true);  // 5,000

        uint256[] memory ids = new uint256[](2);
        ids[0] = 1; ids[1] = 2;

        vm.prank(alice);
        inc.claimTierReward(0, ids);                                  // 10,000 → Bronze
        assertEq(pepe.balanceOf(alice), 500e18);
    }

    /// @dev M6: `isOpen` was never read, so open-and-close-immediately then wait
    ///      30 days collected the "hold" reward for a zero-second hold.
    function test_M6_closedPositionCannotClaimEsgHoldReward() public {
        esg.set(BTC, 80);
        uint256 openedAt = block.timestamp;
        exch.set(7, alice, 100e18, 5, BTC, openedAt, false);   // opened then closed
        vm.warp(openedAt + 31 days);

        vm.prank(alice);
        vm.expectRevert(PepeIncentives.PositionNotOpen.selector);
        inc.claimEsgHoldReward(7);
        assertEq(pepe.balanceOf(alice), 0);
    }

    function test_M6_stillOpenPositionCanClaim() public {
        esg.set(BTC, 80);
        uint256 openedAt = block.timestamp;
        exch.set(8, alice, 100e18, 5, BTC, openedAt, true);
        vm.warp(openedAt + 31 days);

        vm.prank(alice);
        inc.claimEsgHoldReward(8);
        assertEq(pepe.balanceOf(alice), 10e18);
    }

    /// @dev Low: following yourself paid `copyReward` twice to the same address.
    function test_low_selfCopyRewardIsRejected() public {
        copyT.add(alice, alice);
        vm.prank(alice);
        vm.expectRevert(PepeIncentives.SelfCopyNotAllowed.selector);
        inc.claimCopyReward(alice);
        assertEq(pepe.balanceOf(alice), 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PA-9 — PepeStaking
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Normal ERC20 except that transfers OUT of `feeCharged` lose half in
///      transit — a deflationary / fee-on-transfer token, the textbook case the
///      Synthetix budget check exists for. Used to make the reward funding
///      arrive short without touching the staking path.
contract StakePepe {
    mapping(address => uint256) public balanceOf;
    address public feeCharged;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setFeeCharged(address a) external { feeCharged = a; }

    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "insufficient");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "insufficient");
        balanceOf[f] -= a;
        balanceOf[to] += (f == feeCharged) ? a / 2 : a;
        return true;
    }
}

contract AuditPepeStakingTest is Test {
    StakePepe   pepe;
    PepeStaking staking;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        pepe    = new StakePepe();
        staking = new PepeStaking(address(pepe));
        pepe.mint(alice, 100_000e18);
        pepe.mint(bob,   100_000e18);
        pepe.mint(address(this), 100_000e18);
    }

    /// @dev THE PA-9 PoC. Principal and rewards share one balance and the
    ///      Synthetix `rewardRate <= balance / duration` check was missing, so
    ///      a reward period could be promised that the contract could only
    ///      honour by paying out other people's stakes. Here the funding
    ///      arrives half-size (deflationary token); pre-fix the full 7,000 rate
    ///      was accepted anyway, and after seven days alice's claim came
    ///      straight out of the staked principal.
    function test_PA9_rewardRateCannotExceedTheRewardBudget() public {
        vm.prank(alice); staking.stake(10_000e18);

        pepe.setFeeCharged(address(this));          // owner's funding arrives 50% short

        uint256 rate = 7_000e18 / staking.REWARD_DURATION();
        vm.expectRevert(
            abi.encodeWithSelector(
                PepeStaking.RewardExceedsBudget.selector,
                rate * staking.REWARD_DURATION(),
                uint256(3_500e18)                   // balance 13,500 − principal 10,000
            )
        );
        staking.notifyRewardAmount(7_000e18);
    }

    /// @dev The bound is a solvency check, not a blanket block: top the pool up
    ///      to cover the shortfall and the same notify goes through.
    function test_PA9_toppingUpTheBudgetUnblocksTheSameNotify() public {
        vm.prank(alice); staking.stake(10_000e18);
        pepe.setFeeCharged(address(this));

        vm.expectRevert();
        staking.notifyRewardAmount(7_000e18);

        pepe.setFeeCharged(address(0));             // honest funding this time
        staking.notifyRewardAmount(7_000e18);
        assertGe(staking.rewardBudget(), staking.rewardRate() * staking.REWARD_DURATION());
    }

    /// @dev The accounting separation itself: staked principal is never part of
    ///      the distributable pot.
    function test_PA9_rewardBudgetExcludesStakedPrincipal() public {
        vm.prank(alice); staking.stake(10_000e18);
        assertEq(staking.rewardBudget(), 0, "principal is not reward money");

        pepe.transfer(address(staking), 7_000e18);
        assertEq(staking.rewardBudget(), 7_000e18);
    }

    /// @dev The invariant that used to break: after everyone claims, every
    ///      staker can still withdraw their full principal.
    function test_PA9_principalSurvivesFullRewardDistribution() public {
        vm.prank(alice); staking.stake(10_000e18);
        vm.prank(bob);   staking.stake(10_000e18);

        staking.notifyRewardAmount(7_000e18);
        vm.warp(block.timestamp + 7 days);

        vm.prank(alice); staking.claimYield();
        vm.prank(bob);   staking.claimYield();

        vm.prank(alice); staking.withdraw(10_000e18);
        vm.prank(bob);   staking.withdraw(10_000e18);      // used to run dry

        assertGt(pepe.balanceOf(alice), 100_000e18);
        assertGt(pepe.balanceOf(bob),   100_000e18);
        assertEq(staking.totalStaked(), 0);
    }

    function test_PA9_properlyFundedNotifyStillWorks() public {
        vm.prank(alice); staking.stake(10_000e18);
        staking.notifyRewardAmount(7_000e18);
        vm.warp(block.timestamp + 7 days);
        assertApproxEqRel(staking.earned(alice), 7_000e18, 1e15);
    }

}

// ─────────────────────────────────────────────────────────────────────────────
// M8 — KYCRegistry / PepeClaim sybil
// ─────────────────────────────────────────────────────────────────────────────

contract AuditKycClaimTest is Test {
    KYCRegistry kyc;
    PepeToken   pepe;
    PepeClaim   claimC;

    function setUp() public {
        kyc    = new KYCRegistry();
        pepe   = new PepeToken();
        claimC = new PepeClaim(address(pepe), address(kyc));
        pepe.transfer(address(claimC), 10_000_000e18);
    }

    /// @dev THE M8 PoC: `submitKYC` self-approved, so the airdrop's "one per
    ///      verified address" gate cost an attacker exactly one transaction per
    ///      address. Ten sybils, ten claims.
    function test_M8_sybilAirdropIsClosed() public {
        for (uint256 i = 1; i <= 10; i++) {
            address sybil = address(uint160(0x5000 + i));
            vm.prank(sybil); kyc.submitKYC("Sybil", "TW");
            vm.prank(sybil);
            vm.expectRevert(bytes("KYC required"));
            claimC.claim();
            assertEq(pepe.balanceOf(sybil), 0);
        }
    }

    function test_M8_reviewedApplicantCanStillClaim() public {
        address user = makeAddr("user");
        vm.prank(user); kyc.submitKYC("Real Person", "TW");
        kyc.approveKYC(user);

        vm.prank(user); claimC.claim();
        assertEq(pepe.balanceOf(user), 1_000e18);
    }

    /// @dev The exchange's RWA gate reads `isVerified`; its signature and
    ///      meaning are unchanged, only who can set it changed.
    function test_M8_isVerifiedInterfaceUnchanged() public {
        address user = makeAddr("user2");
        assertFalse(kyc.isVerified(user));
        vm.prank(user); kyc.submitKYC("X", "TW");
        assertFalse(kyc.isVerified(user));
        kyc.approveKYC(user);
        assertTrue(kyc.isVerified(user));
        kyc.revokeKYC(user);
        assertFalse(kyc.isVerified(user));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle layer — Chainlink round integrity, Pyth confidence, thresholds
// ─────────────────────────────────────────────────────────────────────────────

/// @dev A feed that has stopped answering: it still returns its last price, but
///      `answeredInRound` lags `roundId`. Indistinguishable from healthy under
///      the old adapter, which only destructured `answer`.
contract StuckAggregatorV3 {
    uint8   public decimals = 8;
    int256  public answer;
    uint256 public updatedAt;
    uint80  public roundId;
    uint80  public answeredInRound;

    constructor(int256 a) {
        answer = a; updatedAt = block.timestamp; roundId = 10; answeredInRound = 10;
    }

    function stall() external { roundId += 5; }              // new rounds, no answers
    function zeroTimestamp() external { updatedAt = 0; }
    function futureTimestamp() external { updatedAt = block.timestamp + 1 days; }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

contract AuditOracleLayerTest is Test {
    ChainlinkOracleAdapter chainlink;
    PythOracleAdapter      pythAdapter;
    MockPyth               pyth;

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant PID = keccak256("pyth-btc");

    function setUp() public {
        vm.warp(1_000_000);
        chainlink   = new ChainlinkOracleAdapter();
        pyth        = new MockPyth();
        pythAdapter = new PythOracleAdapter(address(pyth));
    }

    // ── Chainlink round integrity ───────────────────────────────────────────

    function test_chainlink_incompleteRoundIsRejected() public {
        StuckAggregatorV3 feed = new StuckAggregatorV3(100_000e8);
        chainlink.setFeed(BTC, address(feed));
        (uint256 p, ) = chainlink.getPrice(BTC);
        assertEq(p, 100_000e8, "healthy first");

        feed.stall();                                   // answeredInRound < roundId
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracleAdapter.IncompleteRound.selector, uint80(15), uint80(10))
        );
        chainlink.getPrice(BTC);
        assertTrue(chainlink.isStale(BTC));
    }

    function test_chainlink_zeroTimestampIsRejected() public {
        StuckAggregatorV3 feed = new StuckAggregatorV3(100_000e8);
        chainlink.setFeed(BTC, address(feed));
        feed.zeroTimestamp();
        vm.expectRevert(ChainlinkOracleAdapter.InvalidTimestamp.selector);
        chainlink.getPrice(BTC);
        assertTrue(chainlink.isStale(BTC));
    }

    function test_chainlink_futureTimestampIsRejected() public {
        StuckAggregatorV3 feed = new StuckAggregatorV3(100_000e8);
        chainlink.setFeed(BTC, address(feed));
        feed.futureTimestamp();
        vm.expectRevert(ChainlinkOracleAdapter.InvalidTimestamp.selector);
        chainlink.getPrice(BTC);
    }

    /// @dev Low: a high-decimal feed quoting a sub-1e-8 value truncated to 0,
    ///      and 0 was returned as if it were a price.
    function test_chainlink_normalisationTruncatingToZeroIsRejected() public {
        MockAggregatorV3 feed = new MockAggregatorV3(18, 1);   // 1 wei of an 18-dec quote
        chainlink.setFeed(BTC, address(feed));
        vm.expectRevert(ChainlinkOracleAdapter.InvalidPrice.selector);
        chainlink.getPrice(BTC);
    }

    /// @dev The 24h window was chosen "to match MockOracle"; Chainlink's own
    ///      heartbeat for the majors is ~1h, so it let the mark be a full day
    ///      old with every liveness check green.
    function test_chainlink_defaultThresholdIsOneHourAndTunable() public {
        assertEq(chainlink.staleThreshold(), 1 hours);
        assertEq(chainlink.STALE_THRESHOLD(), 1 hours, "legacy alias still reads");

        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000e8);
        chainlink.setFeed(BTC, address(feed));

        vm.warp(block.timestamp + 2 hours);
        assertTrue(chainlink.isStale(BTC));
        vm.expectRevert();
        chainlink.getPrice(BTC);

        chainlink.setStaleThreshold(6 hours);
        assertFalse(chainlink.isStale(BTC));
        (uint256 p, ) = chainlink.getPrice(BTC);
        assertEq(p, 100_000e8);
    }

    function test_chainlink_thresholdIsBounded() public {
        vm.expectRevert(ChainlinkOracleAdapter.InvalidParam.selector);
        chainlink.setStaleThreshold(1 minutes);
        vm.expectRevert(ChainlinkOracleAdapter.InvalidParam.selector);
        chainlink.setStaleThreshold(48 hours);
    }

    function test_chainlink_thresholdSetterIsOwnerOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        chainlink.setStaleThreshold(2 hours);
    }

    // ── Pyth confidence ─────────────────────────────────────────────────────

    /// @dev `conf` was read into the struct and discarded. During a halt or a
    ///      stressed feed the price stays superficially sane while Pyth itself
    ///      is saying it does not trust it.
    function test_pyth_wideConfidenceIsRejected() public {
        pyth.setPrice(PID, int64(uint64(100_000e8)), -8);
        pythAdapter.setPriceId(BTC, PID);
        (uint256 p, ) = pythAdapter.getPrice(BTC);
        assertEq(p, 100_000e8);

        pyth.setConf(PID, uint64(5_000e8));            // 5% of price, bound is 1%
        vm.expectRevert(
            abi.encodeWithSelector(
                PythOracleAdapter.ConfidenceTooWide.selector, BTC, uint256(5_000e8), uint256(100_000e8)
            )
        );
        pythAdapter.getPrice(BTC);
        assertTrue(pythAdapter.isStale(BTC), "monitoring sees it too");
    }

    function test_pyth_tightConfidenceIsAccepted() public {
        pyth.setPrice(PID, int64(uint64(100_000e8)), -8);
        pythAdapter.setPriceId(BTC, PID);
        pyth.setConf(PID, uint64(500e8));              // 0.5%, inside the 1% bound
        (uint256 p, ) = pythAdapter.getPrice(BTC);
        assertEq(p, 100_000e8);
        assertFalse(pythAdapter.isStale(BTC));
    }

    function test_pyth_confBoundIsTunableAndOwnerOnly() public {
        pyth.setPrice(PID, int64(uint64(100_000e8)), -8);
        pythAdapter.setPriceId(BTC, PID);
        pyth.setConf(PID, uint64(5_000e8));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        pythAdapter.setMaxConfBps(1_000);

        pythAdapter.setMaxConfBps(1_000);              // widen to 10%
        (uint256 p, ) = pythAdapter.getPrice(BTC);
        assertEq(p, 100_000e8);

        vm.expectRevert(PythOracleAdapter.InvalidParam.selector);
        pythAdapter.setMaxConfBps(0);
    }

    /// @dev `getPriceUnsafe` plus "the caller will check the timestamp" is the
    ///      fail-open shape the audit flagged. The time check now happens here,
    ///      against this adapter's own tunable threshold — equivalent to Pyth's
    ///      `getPriceNoOlderThan` without depending on the deployed Pyth version.
    function test_pyth_stalePublishTimeFailsClosed() public {
        pyth.setPrice(PID, int64(uint64(100_000e8)), -8);
        pythAdapter.setPriceId(BTC, PID);

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        pythAdapter.getPrice(BTC);
        assertTrue(pythAdapter.isStale(BTC));
    }

    function test_pyth_futurePublishTimeIsRejected() public {
        pyth.setPrice(PID, int64(uint64(100_000e8)), -8);
        pythAdapter.setPriceId(BTC, PID);
        pyth.setPublishTime(PID, block.timestamp + 1 days);
        vm.expectRevert(PythOracleAdapter.InvalidTimestamp.selector);
        pythAdapter.getPrice(BTC);
    }

    function test_pyth_normalisationTruncatingToZeroIsRejected() public {
        pyth.setPrice(PID, int64(1), -20);             // 1e-20, truncates to 0 at 8-dec
        pythAdapter.setPriceId(BTC, PID);
        vm.expectRevert(PythOracleAdapter.InvalidPrice.selector);
        pythAdapter.getPrice(BTC);
    }

    function test_pyth_defaultThresholdIsOneHourAndBounded() public {
        assertEq(pythAdapter.staleThreshold(), 1 hours);
        assertEq(pythAdapter.STALE_THRESHOLD(), 1 hours);
        vm.expectRevert(PythOracleAdapter.InvalidParam.selector);
        pythAdapter.setStaleThreshold(1 minutes);
        vm.expectRevert(PythOracleAdapter.InvalidParam.selector);
        pythAdapter.setStaleThreshold(48 hours);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PA-7 — the aggregator must not route around a deliberate fail-closed source
// ─────────────────────────────────────────────────────────────────────────────

contract AuditAggregatorFailClosedTest is Test {
    GuardedOracle           guarded;
    ChainlinkOracleAdapter  chainlink;
    AggregatorOracleAdapter agg;
    MockAggregatorV3        feed;

    address keeper   = makeAddr("keeper");
    address guardian = makeAddr("guardian");

    bytes32 constant BTC = keccak256("BTC");

    function setUp() public {
        vm.warp(1_000_000);
        guarded = new GuardedOracle(address(this));
        guarded.grantRole(guarded.KEEPER_ROLE(), keeper);
        guarded.grantRole(guarded.GUARDIAN_ROLE(), guardian);
        guarded.addAsset(BTC, 100_000e8);

        chainlink = new ChainlinkOracleAdapter();
        feed = new MockAggregatorV3(8, 100_000e8);
        chainlink.setFeed(BTC, address(feed));

        agg = new AggregatorOracleAdapter(address(guarded), address(chainlink));
    }

    function test_healthyPairServesPrice() public view {
        (uint256 p, ) = agg.getPrice(BTC);
        assertEq(p, 100_000e8);
    }

    /// @dev THE PA-7 PoC. A guardian freezes the asset — that is the emergency
    ///      stop, and GuardedOracle.getPrice reverts `AssetIsFrozen` to enforce
    ///      it. The aggregator's blanket `catch { return (false, ...) }` read
    ///      that as "source down" and cheerfully served the OTHER source, so
    ///      freezing achieved nothing while any feed still answered. `_probe`
    ///      now inspects the selector and re-raises the refusal.
    function test_PA7_guardianFreezeIsNotRoutedAround() public {
        vm.prank(guardian);
        guarded.setAssetFrozen(BTC, true);

        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, BTC));
        agg.getPrice(BTC);

        // …and enabling single-source degradation does NOT re-open the hole.
        agg.setAllowSingleSource(true);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, BTC));
        agg.getPrice(BTC);
    }

    /// @dev The distinction that matters: genuine unavailability still degrades
    ///      (when allowed), only deliberate refusals propagate.
    function test_PA7_unconfiguredSourceStillDegradesWhenAllowed() public {
        bytes32 other = keccak256("ETH");
        MockAggregatorV3 f2 = new MockAggregatorV3(8, 3_000e8);
        chainlink.setFeed(other, address(f2));
        // `other` is not registered on the GuardedOracle → AssetNotFound.

        vm.expectRevert(
            abi.encodeWithSelector(AggregatorOracleAdapter.SingleSourceNotAllowed.selector, other)
        );
        agg.getPrice(other);

        agg.setAllowSingleSource(true);
        (uint256 p, ) = agg.getPrice(other);
        assertEq(p, 3_000e8);
    }

    /// @dev A stale (not frozen) GuardedOracle asset is genuine unavailability.
    function test_PA7_staleSourceDegradesRatherThanPropagating() public {
        agg.setAllowSingleSource(true);
        vm.warp(block.timestamp + 2 hours);      // GuardedOracle maxPriceAge = 1h
        feed.setAnswer(100_000e8);               // keep Chainlink fresh

        (uint256 p, ) = agg.getPrice(BTC);
        assertEq(p, 100_000e8);
    }

    function test_PA7_allowSingleSourceIsOwnerOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        agg.setAllowSingleSource(true);
    }

    function test_PA7_defaultsAreFailClosed() public view {
        assertFalse(agg.allowSingleSource());
        assertEq(agg.maxDeviationBps(), 100);
        assertEq(agg.haltDeviationBps(), 2_000);
    }

    function test_haltBoundCannotBeSetBelowSoftBound() public {
        vm.expectRevert(AggregatorOracleAdapter.InvalidParam.selector);
        agg.setHaltDeviationBps(50);
        vm.expectRevert(AggregatorOracleAdapter.InvalidParam.selector);
        agg.setMaxDeviationBps(3_000);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// M-2 — GuardedOracle: the deviation cap and the reference check used to
//        contradict each other, freezing the price during a gap
// ─────────────────────────────────────────────────────────────────────────────

contract RefFeed {
    mapping(bytes32 => uint256) public p;
    function set(bytes32 id, uint256 v) external { p[id] = v; }
    function getPrice(bytes32 id) external view returns (uint256, uint256) {
        return (p[id], block.timestamp);
    }
}

contract AuditGuardedOracleDeadlockTest is Test {
    GuardedOracle oracle;
    RefFeed       ref;

    address keeper = makeAddr("keeper");
    bytes32 constant ID = keccak256("sBTC");

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new GuardedOracle(address(this));
        oracle.grantRole(oracle.KEEPER_ROLE(), keeper);
        oracle.addAsset(ID, 100_000e8);
        ref = new RefFeed();
        oracle.setReferenceSource(address(ref));
    }

    /// @dev THE M-2 DEADLOCK. Market gaps −30%. The step cap (10%) refuses the
    ///      true price; the reference check refused every legal 10% step
    ///      because a −10% price is still 22% away from a −30% reference. Both
    ///      gates locked and the oracle sat at the pre-gap price — the one
    ///      moment liquidations most need to fire. The only escape was an admin
    ///      setting the cap to 0, i.e. deleting the control.
    ///
    ///      Now: a post the reference CONFIRMS is not an unverified move, so
    ///      the step cap does not apply. A real 30% gap lands in one call.
    function test_M2_thirtyPercentGapLandsInOneConfirmedPost() public {
        ref.set(ID, 70_000e8);                    // decentralized feed sees the crash

        vm.prank(keeper);
        oracle.updatePrice(ID, 70_000e8);

        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 70_000e8, "the oracle must be able to follow the market");
    }

    /// @dev And when the reference does NOT confirm, the keeper can still make
    ///      progress: a converging step inside the cap is accepted. Under the
    ///      old rule this exact post was rejected `ReferenceDisagrees`, which
    ///      is what made the deadlock total.
    function test_M2_convergingStepsAreAcceptedWhenReferenceDisagrees() public {
        ref.set(ID, 70_000e8);

        // 90,000 is a legal −10% step but still 28.6% off the reference.
        vm.prank(keeper);
        oracle.updatePrice(ID, 90_000e8);
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 90_000e8);

        // Keep walking down; each step is closer to the reference.
        vm.prank(keeper); oracle.updatePrice(ID, 81_000e8);
        vm.prank(keeper); oracle.updatePrice(ID, 73_000e8);
        vm.prank(keeper); oracle.updatePrice(ID, 70_000e8);
        (p, ) = oracle.getPrice(ID);
        assertEq(p, 70_000e8);
    }

    /// @dev The guard is still a guard: a post that moves AWAY from the
    ///      reference is refused, confirmed or not.
    function test_M2_divergingPostIsStillRejected() public {
        ref.set(ID, 90_000e8);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardedOracle.ReferenceDisagrees.selector, ID, uint256(108_000e8), uint256(90_000e8)
            )
        );
        oracle.updatePrice(ID, 108_000e8);        // legal step, wrong direction
    }

    /// @dev Without a reference the step cap alone still bounds a compromised
    ///      keeper — the confirmation bypass is not a general escape hatch.
    function test_M2_withoutReferenceTheStepCapStillBinds() public {
        oracle.setReferenceSource(address(0));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardedOracle.DeviationTooLarge.selector, ID, uint256(70_000e8), uint256(100_000e8)
            )
        );
        oracle.updatePrice(ID, 70_000e8);
    }

    /// @dev A compromised keeper cannot fabricate a jump: the reference has to
    ///      agree with the number being posted, and the reference is the
    ///      decentralized feed.
    function test_M2_keeperCannotJumpWithoutReferenceAgreement() public {
        ref.set(ID, 100_000e8);                   // reference says nothing moved
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardedOracle.ReferenceDisagrees.selector, ID, uint256(10e8), uint256(100_000e8)
            )
        );
        oracle.updatePrice(ID, 10e8);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// M-5 — AssetVaultV2_2.registerAsset
// ─────────────────────────────────────────────────────────────────────────────

contract AuditVaultV2_2RegisterAssetTest is Test {
    AssetVaultV2_2  vault;
    MockUSDC        usdc;
    MockOracle      oracle;
    SyntheticAssetV2 tokenA;
    SyntheticAssetV2 tokenB;

    address alice = makeAddr("alice");
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        vm.warp(1_000_000);
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AID, 200e8);

        AssetVaultV2_2 impl = new AssetVaultV2_2();
        vault = AssetVaultV2_2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_2.initialize, (address(usdc), address(oracle), address(this)))
        )));

        tokenA = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, address(this));
        tokenB = new SyntheticAssetV2("Synthetic Evil",  "sEVIL", AID, address(this));
        tokenA.grantRole(tokenA.MINTER_ROLE(), address(vault));
        tokenB.grantRole(tokenB.MINTER_ROLE(), address(vault));

        vault.registerAsset(AID, address(tokenA));
        vault.setAssetCap(AID, 100_000e18);

        usdc.mint(address(this), 1_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(500_000e18);

        usdc.mint(alice, 100_000e18);
        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice); vault.mint(AID, 2_000e18);
    }

    /// @dev M-5: `unregisterAsset` refuses while units are outstanding but
    ///      `registerAsset` did not, so an admin could re-point a live asset id
    ///      at a different token. `redeem` would then burn from a token holders
    ///      do not have while `_outstanding` still recorded the old liability.
    ///      V2.0/V2.1 were fixed separately; this closes it in V2.2.
    function test_M5_cannotRepointAssetWhileUnitsAreOutstanding() public {
        assertGt(vault.exposureOf(AID), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                AssetVaultV2_2.AssetStillOutstanding.selector, AID, vault.exposureOf(AID)
            )
        );
        vault.registerAsset(AID, address(tokenB));

        assertEq(vault.assetToken(AID), address(tokenA), "binding unchanged");
    }

    /// @dev Idempotent re-registration of the SAME token stays allowed.
    function test_M5_sameTokenReRegistrationStillAllowed() public {
        vault.registerAsset(AID, address(tokenA));
        assertEq(vault.assetToken(AID), address(tokenA));
    }

    /// @dev Once holders have redeemed, re-pointing is safe again.
    function test_M5_repointAllowedOnceFullyRedeemed() public {
        uint256 bal = tokenA.balanceOf(alice);
        vm.prank(alice); vault.redeem(AID, bal);
        assertEq(vault.exposureOf(AID), 0);

        vault.registerAsset(AID, address(tokenB));
        assertEq(vault.assetToken(AID), address(tokenB));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Low — ERC20 return values across the periphery
// ─────────────────────────────────────────────────────────────────────────────

/// @dev USDT-style token: transfer/transferFrom return NOTHING. A bare
///      `IERC20(t).transfer(...)` reverts decoding a bool that never came.
contract VoidReturnPepe {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a; balanceOf[to] += a;
    }
    function transferFrom(address f, address to, uint256 a) external {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a;
    }
}

contract AuditPeripherySafeErc20Test is Test {
    address alice = makeAddr("alice");

    /// @dev M-4 for the periphery: PepeStaking used raw `transfer`/
    ///      `transferFrom`, so a non-compliant reward token bricked every path.
    function test_low_stakingWorksWithNonCompliantErc20() public {
        VoidReturnPepe tok = new VoidReturnPepe();
        PepeStaking staking = new PepeStaking(address(tok));

        tok.mint(alice, 10_000e18);
        tok.mint(address(this), 10_000e18);

        vm.prank(alice); tok.approve(address(staking), type(uint256).max);
        vm.prank(alice); staking.stake(1_000e18);          // used to revert

        tok.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(7_000e18);
        vm.warp(block.timestamp + 7 days);

        vm.prank(alice); staking.exit();
        assertGt(tok.balanceOf(alice), 10_000e18);
    }

    function test_low_claimWorksWithNonCompliantErc20() public {
        VoidReturnPepe tok = new VoidReturnPepe();
        KYCRegistry kyc = new KYCRegistry();
        PepeClaim claimC = new PepeClaim(address(tok), address(kyc));

        tok.mint(address(claimC), 100_000e18);
        vm.prank(alice); kyc.submitKYC("A", "TW");
        kyc.approveKYC(alice);

        vm.prank(alice); claimC.claim();                   // used to revert
        assertEq(tok.balanceOf(alice), 1_000e18);
    }
}
