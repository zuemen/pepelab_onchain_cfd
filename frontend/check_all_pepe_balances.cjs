const { ethers } = require('ethers');

const provider = new ethers.JsonRpcProvider('https://sepolia.infura.io/v3/7cdfb4923cee46ed9238a5181e4e9a4d');
const PEPE_TOKEN = '0xa364F43627A17BE5bfbcb32693f3eD7E44ebe1D9';

const addresses = {
  Deployer: '0xE80A81360608C1342e66743F70a00f75d792Eb93',
  PepeIncentivesOld: '0x33963D72EB305ddBb027E1aEC2785579ba685d71',
  PepeClaim: '0x852c0fBa54552aafbA4798709d90056159682A4C',
  EsgRewardDistributor: '0xA1a522B9d31e5B48E41DcCd050DE10dA2e3BEdD0',
  PepeAMM: '0x612674Ab98589228309353FCc2f9d88Cc830CBdF'
};

const erc20Abi = ['function balanceOf(address) view returns (uint256)'];

async function main() {
  const pepe = new ethers.Contract(PEPE_TOKEN, erc20Abi, provider);
  for (const [name, addr] of Object.entries(addresses)) {
    const bal = await pepe.balanceOf(addr);
    console.log(`${name.padEnd(22)} (${addr}): ${ethers.formatEther(bal)} PEPE`);
  }
}

main().catch(console.error);
