const asyncAuto = require('async/auto');
const asyncMapSeries = require('async/mapSeries');
const {returnResult} = require('asyncjs-util');

const {getBlock} = require('./../../chain');
const {getTransaction} = require('./../../chain');
const {Transaction} = require('./../../tokenslib');

/** Get details for a block

  {
    id: <Block Hash Hex String>
    network: <Network Name String>
  }

  @returns via cbk
  {
    transactions: [{
      id: <Transaction Id Hex String>
      outputs: [{
        tokens: <Tokens Send Number>
      }]
    }]
  }
*/
module.exports = ({id, network}, cbk) => {
  return asyncAuto({
    // Get the high level block details, with transaction ids
    getBlock: cbk => getBlock({id, network}, cbk),

    // Get the transactions out of the blocks
    getTransactions: ['getBlock', ({getBlock}, cbk) => {
      return asyncMapSeries(getBlock.transaction_ids, (id, cbk) => {
        return getTransaction({id, network}, cbk);
      },
      cbk);
    }],

    // Final set of transactions in the block
    transactions: ['getTransactions', ({getTransactions}, cbk) => {
      // Convert raw tx hexes into ids and output tokens
      const transactions = getTransactions
        .map(({transaction}) => transaction) // Pluck out transaction
        .map(txHex => Transaction.fromHex(txHex)) // Convert to a Transaction
        .map(tx => ({id: tx.getId(), o: tx.outs})) // Pluck id and outputs
        .map(t => ({id: t.id, outputs: t.o.map(o => ({tokens: o.value}))}));

      return cbk(null, {transactions});
    }],
  },
  returnResult({of: 'transactions'}, cbk));
};

