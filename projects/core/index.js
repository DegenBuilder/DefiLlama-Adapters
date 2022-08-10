
const sdk = require('@defillama/sdk');
const BigNumber = require("bignumber.js");
const getReserves = require('./abis/uniswap/getReserves.json');
const token0 = require('./abis/uniswap/token0.json');
const token1 = require('./abis/uniswap/token1.json');
const numTokensWrapped = require('./abis/erc95/numTokensWrapped.json');
const getTokenInfo = require('./abis/erc95/getTokenInfo.json');
const { staking }= require("../helper/staking");
const { sumTokensAndLPsSharedOwners }= require("../helper/unwrapLPs");

const vaultStakingContract = "0xc5cacb708425961594b63ec171f4df27a9c0d8c9";
const treasurycontract = "0x5A16552f59ea34E44ec81E58b3817833E9fD5436";
const clend = "0x54b276c8a484ebf2a244d933af5ffaf595ea58c5";

const CORE = "0x62359Ed7505Efc61FF1D56fEF82158CcaffA23D7";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const DELTA = "0x9EA3b5b4EC044b70375236A281986106457b20EF";
const COREDAO = "0xf66Cd2f8755a21d3c8683a10269F795c0532Dd58";

const zero = new BigNumber(0);

const configs = {
  pairAddresses: [
    '0x32Ce7e48debdccbFE0CD037Cc89526E4382cb81b', // CORE/WETH
    '0x6fad7D44640c5cd0120DEeC0301e8cf850BecB68', // CORE/cBTC
    '0x01AC08E821185b6d87E68c67F9dc79A8988688EB', // coreDAI/wCORE
	'0x85d9DCCe9Ea06C2621795889Be650A8c3Ad844BB', // CORE/Fanny
  ],
  erc95TokenAddresses: [
    '0x7b5982dcAB054C377517759d0D2a3a5D02615AB8', // cBTC
    '0x00a66189143279b6DB9b77294688F47959F37642', // coreDAI,
    '0x17B8c1A92B66b1CF3092C5d223Cb3a129023b669', // wCORE
  ],
}

/**
 * Retrieve all the Uniswap pair information.
 * 
 * @param {[String]} pairAddresses The uniswap pair addresses
 * @param {any} timestamp 
 * @param {any} block 
 * @returns {Promise<[{ token0: String,  token1: String, reserve0: String, reserve1: String }]>}
 */
async function getUniswapPairInfo(pairAddresses, timestamp, block) {
  const [token0Addresses, token1Addresses, reserves, totalSupplies] = await Promise.all([
    sdk.api.abi.multiCall({
      abi: token0,
      calls: pairAddresses.map((pairAddress) => ({
        target: pairAddress,
      })),
      block,
    })
      .then(({ output }) => output.map(value => value.output)),
    sdk.api.abi.multiCall({
      abi: token1,
      calls: pairAddresses.map((pairAddress) => ({
        target: pairAddress,
      })),
      block,
    })
      .then(({ output }) => output.map(value => value.output)),
    sdk.api.abi.multiCall({
      abi: getReserves,
      calls: pairAddresses.map((pairAddress) => ({
        target: pairAddress,
      })),
      block,
    })
      .then(({ output }) => output.map(value => value.output)),
    sdk.api.abi.multiCall({
      block,
      calls: pairAddresses.map(pairAddress => ({
        target: pairAddress
      })),
      abi: 'erc20:totalSupply',
    }).then(({ output }) => output.map(value => value.output))
  ]);
  return pairAddresses.map((_value, index) => {
    return {
      reserve0: reserves[index] ? reserves[index]['reserve0'] : null,
      reserve1: reserves[index] ? reserves[index]['reserve1'] : null,
      token0: token0Addresses[index],
      token1: token1Addresses[index],
      totalSupply: totalSupplies[index],
    }
  })
}

/**
 * Retrieve the underlying reserve of each token within a pair.
 * 
 * @param {{ token0: String, token1: String, reserve0: String, reserve1: String }} pairInfo Contains the information about a pair.
 * @param {any} timestamp 
 * @param {any} block
 * @returns {Promise<{ [String]: BigNumber }>}
 */
async function getPairUnderlyingReserves(pairInfo, timestamp, block) {
  return Promise.all([
    getTokenUnderlyingReserves(pairInfo.token0, pairInfo.reserve0, timestamp, block),
    getTokenUnderlyingReserves(pairInfo.token1, pairInfo.reserve1, timestamp, block)
  ]);
};

/**
 * Retrieve the token reserve and if it's an ERC95 token, retrieve
 * each underlying assets reserves.
 * 
 * @param {String} token Token address
 * @param {String} defaultReserve Default reserve amount to use when not a ERC95 token
 * @param {any} timestamp 
 * @param {any} block
 * @returns {Promise<{ [String]: BigNumber }>}
 */
async function getTokenUnderlyingReserves(token, defaultReserve, _timestamp, block) {
  if (configs.erc95TokenAddresses.indexOf(token) === -1) {
    return [{ [token]: defaultReserve }];
  }

  const numTokensWrappedResponse = await sdk.api.abi.call({
    target: token,
    abi: numTokensWrapped,
    block
  });

  const wrappedTokenCount = parseInt(numTokensWrappedResponse.output);
  const getTokenInfoCalls = []
  for (let i = 0;i < wrappedTokenCount; i++)
    getTokenInfoCalls.push({
      target: token,
      params: [i],
      abi: getTokenInfo,
      block
    })

  const tokenInfoResponse = await sdk.api.abi.multiCall({
    block,
    calls: getTokenInfoCalls,
    abi: getTokenInfo,
  });

  const reserves = tokenInfoResponse.output.map(info => ({
    [info.output.address]: info.output.reserve
  }));

  return reserves;
};

/**
 * Flatten and merge common underlying assets with their reserve sum.
 *
 * @param {[{[String]: BigNumber}]} underlyingReserves 
 * @returns {{[String]: [String]}} An object of the token address and its reserve.
 */
function flattenUnderlyingReserves(underlyingReserves) {
  const reserves = {};

  underlyingReserves.forEach(pairReserves => {
    pairReserves.forEach(tokenReserves => {
      tokenReserves.forEach(underlyingReserves => {
        Object.keys(underlyingReserves).forEach(address => {
          const tokenReserve = new BigNumber(underlyingReserves[address]);
          reserves[address] = (reserves[address] || zero).plus(tokenReserve);
        });
      });
    });
  });

  Object.keys(reserves).forEach(address => {
    reserves[address] = reserves[address].toFixed();
  });

  return reserves;
}

async function LGEtvl(timestamp, block) {
  const pairInfo = await getUniswapPairInfo(configs.pairAddresses, timestamp, block);
  const underlyingReserves = await Promise.all(pairInfo.map(info => getPairUnderlyingReserves(info, timestamp, block)));
  const balances = flattenUnderlyingReserves(underlyingReserves);

  return balances;
}
async function LGEtreasury(timestamp, block) {
const balances = {};

await sumTokensAndLPsSharedOwners(
    balances,
    [
      [CORE, false],
      [DAI, false],
	  [WETH, false],
	  [DELTA, false],
	  [COREDAO, false],
    ],
    [treasurycontract,clend,vaultStakingContract],
    block,
    'ethereum'
  );
  return balances;
 
}

module.exports = {
  misrepresentedTokens: true,
  start: 1601142406, 
  ethereum: {
	staking: staking(vaultStakingContract, CORE),
	treasury:LGEtreasury,
    tvl:LGEtvl
  },
  methodology: "Counts liquidty on the Staking and Pool2",
};