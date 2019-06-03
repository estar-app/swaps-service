const asyncAuto = require('async/auto');
const {returnResult} = require('asyncjs-util');

const {getBlock} = require('./../chain');
const {getJsonFromCache} = require('./../cache');
const {setJsonInCache} = require('./../cache');

const blockExpirationMs = 1000 * 60 * 5;
const type = 'get_block_metadata';

/** Get block metadata

  {
    id: <Block Id Hex String>
    network: <Network Name String>
  }

  @returns via cbk
  {
    previous_block_hash: <Previous Block Hash Hex String>
    transaction_ids: [<Transaction Id Hex String>]
  }
*/
module.exports = ({id, network}, cbk) => {
  return asyncAuto({
    // See if we have cached block metadata
    getCached: cbk => getJsonFromCache({
      type,
      cache: 'memory',
      key: [id, network].join(),
    },
    cbk),

    // Check arguments
    validate: cbk => {
      if (!id) {
        return cbk([400, 'ExpectedBlockIdToLookupMetadataFor']);
      }

      if (!network) {
        return cbk([400, 'ExpectedNetworkForBlockMetadataLookup']);
      }

      return cbk();
    },

    // Get the block
    getBlock: ['getCached', 'validate', ({getCached}, cbk) => {
      const cached = getCached;

      if (!!cached && !!cached.previous_block_hash && !!cached.network) {
        return cbk(null, {
          is_cached: true,
          network: cached.network,
          previous_block_hash: cached.previous_block_hash,
          transaction_ids: cached.transaction_ids,
        });
      }

      return getBlock({id, network}, (err, res) => {
        if (!!err) {
          return cbk(err);
        }

        return cbk(null, {
          network,
          previous_block_hash: res.previous_block_hash,
          transaction_ids: res.transaction_ids,
        });
      });
    }],

    // Add the block to the cache
    setCached: ['getBlock', ({getBlock}, cbk) => {
      // Exit early when we had a hot cache
      if (!!getBlock.is_cached) {
        return cbk();
      }

      return setJsonInCache({
        type,
        cache: 'memory',
        key: [id, network].join(),
        ms: blockExpirationMs,
        value: {
          network,
          previous_block_hash: getBlock.previous_block_hash,
          transaction_ids: getBlock.transaction_ids,
        },
      },
      cbk);
    }],
  },
  returnResult({of: 'getBlock'}, cbk));
};

