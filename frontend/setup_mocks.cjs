const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
  const provider = new ethers.JsonRpcProvider("https://sepolia.infura.io/v3/7cdfb4923cee46ed9238a5181e4e9a4d");
  const adminWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // Addresses
  const USDC_ADDR = "0x655D51EDE4439d66894663AD4725770381db3EBa";
  const REGISTRY_ADDR = "0x5f98b068480334633EdA2C1051293b325e1e5c20";
  const STAKE_ADDR = "0x11D1E96aa302a93897de8e60CB00b38247Fafc78";

  // ABIs
  const usdcAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "src/contracts/abi/MockUSDC.json")));
  const registryAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "src/contracts/abi/StrategyRegistry.json")));
  const stakeAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "src/contracts/abi/TraderStake.json")));

  const usdc = new ethers.Contract(USDC_ADDR, usdcAbi, adminWallet);

  const MOCK_TRADERS = [
    { name: "Crypto_Chad", pk: "0x1111111111111111111111111111111111111111111111111111111111111111", stake: "5000" },
    { name: "Tech_Bear_Fund", pk: "0x2222222222222222222222222222222222222222222222222222222222222222", stake: "10000" },
    { name: "Stable_Quant", pk: "0x3333333333333333333333333333333333333333333333333333333333333333", stake: "25000" }
  ];

  for (let mt of MOCK_TRADERS) {
    console.log(`Setting up ${mt.name}...`);
    const traderWallet = new ethers.Wallet(mt.pk, provider);
    
    // 1. Send ETH for gas (0.005 ETH)
    const ethTx = await adminWallet.sendTransaction({ to: traderWallet.address, value: ethers.parseEther("0.005") });
    await ethTx.wait();
    console.log(`  Sent ETH to ${traderWallet.address}`);

    // 2. Mint USDC
    const usdcTx = await usdc.mint(traderWallet.address, ethers.parseEther(mt.stake));
    await usdcTx.wait();
    console.log(`  Minted ${mt.stake} USDC`);

    // Connect trader
    const tRegistry = new ethers.Contract(REGISTRY_ADDR, registryAbi, traderWallet);
    const tStake = new ethers.Contract(STAKE_ADDR, stakeAbi, traderWallet);
    const tUsdc = new ethers.Contract(USDC_ADDR, usdcAbi, traderWallet);

    // 3. Register Profile
    const profileTx = await tRegistry.registerTrader(mt.name);
    await profileTx.wait();
    console.log(`  Profile registered`);

    // 4. Stake USDC
    const approveTx = await tUsdc.approve(STAKE_ADDR, ethers.parseEther(mt.stake));
    await approveTx.wait();
    const stakeTx = await tStake.stake(ethers.parseEther(mt.stake));
    await stakeTx.wait();
    console.log(`  Staked USDC`);

    // 5. Publish strategy
    const ASSET_BTC = "0x6587d61b59ac1e9c9f12c71f220fb1b1740d054e81277d4466a0d348e0e266e1";
    let stratTx;
    if (mt.name === "Crypto_Chad") {
        stratTx = await tRegistry.publishStrategy([
            { asset: ASSET_BTC, weight: 10000, isLong: true, leverage: 5 }
        ]);
    } else {
        stratTx = await tRegistry.publishStrategy([
            { asset: ASSET_BTC, weight: 10000, isLong: false, leverage: 2 }
        ]);
    }
    await stratTx.wait();
    console.log(`  Strategy published!`);
  }
}

main().catch(console.error);
