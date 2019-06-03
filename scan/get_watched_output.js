const asyncAuto = require('async/auto');
const {returnResult} = require('asyncjs-util');

const {getJsonFromCache} = require('./../cache');
const {swapScriptDetails} = require('./../swaps');

const lastAddress = {};

/** Get details about a watched output

  {
    cache: <Cache Type String>
    address: <Address String>
    network: <Network Name String>
  }

  @returns via cbk
  {
    [swap]: {
      index: <Claim Key Index Number>
      invoice: <BOLT 11 Invoice String>
      script: <Output Redeem Script>
      tokens: <Tokens Expected Number>
      type: <Type String> 'funding'
    }
  }
*/
module.exports = ({address, cache, network}, cbk) => {
  return asyncAuto({
    // Check arguments
    validate: cbk => {
      if (!address) {
        return cbk([400, 'ExpectedAddress']);
      }

      if (!cache) {
        return cbk([400, 'ExpectedCacheTypeForWatchedOutput']);
      }

      if (!network) {
        return cbk([400, 'ExpectedNetworkForWatchedOutput']);
      }

      return cbk();
    },

    // Find cached address
    getCachedAddress: ['validate', ({}, cbk) => {
      // Exit early when the last address lookup is hit
      if (!!lastAddress[network] && lastAddress[network].address === address) {
        return cbk(null, lastAddress[network].swap);
      }

      return getJsonFromCache({
        cache,
        key: address,
        type: 'swap_address',
      },
      (err, res) => {
        if (!!err) {
          return cbk(err);
        }

        if (!res || !res.id || !res.script || !res.tokens) {
          return cbk();
        }

        const swap = {id: res.id, script: res.script, tokens: res.tokens};

        lastAddress[network] = {address, swap};

        return cbk(null, swap);
      });
    }],

    // Derive the claim public key 
    swapClaimPublicKey: ['getCachedAddress', ({getCachedAddress}, cbk) => {
      if (!getCachedAddress) {
        return cbk();
      }

      const {script} = getCachedAddress;

      try {
        const scriptDetails = swapScriptDetails({network, script});

        return cbk(null, scriptDetails.destination_public_key);
      } catch (err) {
        // Exit early and do not pass along errors.
        return cbk();
      }
    }],

    // Find the public key id
    getClaimKeyIndex: ['swapClaimPublicKey', ({swapClaimPublicKey}, cbk) => {
      if (!swapClaimPublicKey) {
        return cbk();
      }

      return getJsonFromCache({
        cache,
        key: swapClaimPublicKey,
        type: 'swap_key',
      },
      (err, res) => {
        if (!!err) {
          return cbk(err);
        }

        if (!res || !res.index) {
          return cbk();
        }

        return cbk(null, {index: res.index});
      });
    }],

    // Find cached invoice
    getCachedInvoice: ['getCachedAddress', ({getCachedAddress}, cbk) => {
      // Exit early when there is no hit for the cached address
      if (!getCachedAddress) {
        return cbk();
      }

      return getJsonFromCache({
        cache,
        key: getCachedAddress.id,
        type: 'invoice',
      },
      (err, res) => {
        if (!!err) {
          return cbk(err);
        }

        if (!res || !res.invoice) {
          return cbk();
        }

        return cbk(null, {invoice: res.invoice});
      });
    }],

    // Final swap details
    swap: [
      'getCachedAddress',
      'getCachedInvoice',
      'getClaimKeyIndex',
      ({getCachedAddress, getCachedInvoice, getClaimKeyIndex}, cbk) =>
    {
      if (!getClaimKeyIndex || !getCachedAddress || !getCachedInvoice) {
        return cbk(null, {});
      }

      return cbk(null, {
        swap: {
          index: getClaimKeyIndex.index,
          invoice: getCachedInvoice.invoice,
          script: getCachedAddress.script,
          tokens: getCachedAddress.tokens,
          type: 'funding',
        },
      });
    }],
  },
  returnResult({of: 'swap'}, cbk));
};

