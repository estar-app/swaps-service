const asyncAuto = require('async/auto');
const asyncConstant = require('async/constant');

const macros = './macros/';

const addressForPublicKey = require(`${macros}address_for_public_key`);
const broadcastTransaction = require(`${macros}broadcast_transaction`);
const chainSwapAddress = require(`${macros}chain_swap_address`);
const generateChainBlocks = require(`${macros}generate_chain_blocks`);
const generateInvoice = require(`${macros}generate_invoice`);
const generateKeyPair = require(`${macros}generate_keypair`);
const getBlockchainInfo = require(`${macros}get_blockchain_info`);
const mineTransaction = require(`${macros}mine_transaction`);
const outputScriptInTransaction = require(`${macros}output_script_in_tx`);
const refundTransaction = require(`${macros}refund_transaction`);
const returnResult = require(`${macros}return_result`);
const sendChainTokensTransaction = require(`${macros}send_chain_tokens_tx`);
const spawnChainDaemon = require(`${macros}spawn_chain_daemon`);
const stopChainDaemon = require(`${macros}stop_chain_daemon`);

const chain = require('./conf/chain');
const errCode = require('./conf/error_codes');

const staticFeePerVirtualByte = 100;
const swapTimeoutBlockCount = 25;

/** Test a refund success script against regtest

  In this test, a swap script will be generated where Alice locks funds to a
  hash plus Bob's key. But something goes wrong and Bob never claims his funds.
  Alice waits out the timeout and takes her tokens back.

  {}

  @returns via cbk
  {
    network: <Network Name String>
  }
*/
module.exports = (args, cbk) => {
  return asyncAuto({
    // The network is chosen to perform the test
    network: asyncConstant('regtest'),

    // Alice generates a keypair for her refund output.
    generateAliceKeyPair: ['network', ({network}, cbk) => {
      return generateKeyPair({network}, cbk);
    }],

    // Chain sync is started. Alice will get block rewards for use in deposit
    spawnChainDaemon: ['generateAliceKeyPair', (res, cbk) => {
      return spawnChainDaemon({
        mining_public_key: res.generateAliceKeyPair.public_key,
        network: res.network,
      },
      cbk);
    }],

    // Bob generates a keypair for his claim output
    generateBobKeyPair: ['network', ({network}, cbk) => {
      return generateKeyPair({network}, cbk);
    }],

    // Alice generates a Lightning invoice which gives a preimage/hash
    generatePaymentPreimage: ['generateAliceKeyPair', (res, cbk) => {
      return generateInvoice({
        private_key: res.generateAliceKeyPair.private_key,
      },
      cbk);
    }],

    // Alice makes an address to claim her refund
    createAliceAddress: ['generateAliceKeyPair', (res, cbk) => {
      return addressForPublicKey({
        network: res.network,
        public_key: res.generateAliceKeyPair.public_key,
      },
      cbk);
    }],

    // A bunch of blocks are made so Alice's rewards are mature
    generateToMaturity: ['network', 'spawnChainDaemon', (res, cbk) => {
      return generateChainBlocks({
        blocks_count: chain.maturity_block_count,
        network: res.network,
      },
      cbk);
    }],

    // Get the state of the chain at maturity when Alice is ready to spend
    getMatureChainInfo: ['generateToMaturity', ({network}, cbk) => {
      return getBlockchainInfo({network}, cbk);
    }],

    // Determine the height at which a refund is possible
    swapRefundHeight: ['getMatureChainInfo', (res, cbk) => {
      const matureHeight = res.getMatureChainInfo.current_height;

      return cbk(null, matureHeight + swapTimeoutBlockCount);
    }],

    // A chain swap address is created. Claim: Bob. Refund: Alice.
    createChainSwapAddress: [
      'generateAliceKeyPair',
      'generateBobKeyPair',
      'generatePaymentPreimage',
      'swapRefundHeight',
      (res, cbk) =>
    {
      return chainSwapAddress({
        destination_public_key: res.generateBobKeyPair.public_key,
        payment_hash: res.generatePaymentPreimage.payment_hash,
        refund_public_key: res.generateAliceKeyPair.public_key,
        timeout_block_height: res.swapRefundHeight,
      },
      cbk);
    }],

    // Alice selects a UTXO to send to the swap address
    aliceUtxo: ['generateToMaturity', (res, cbk) => {
      const [firstRewardBlock] = res.generateToMaturity.blocks;

      const [coinbaseTransaction] = firstRewardBlock.transactions;

      const [firstCoinbaseOutput] = coinbaseTransaction.outputs;

      return cbk(null, {
        tokens: firstCoinbaseOutput.tokens,
        transaction_id: coinbaseTransaction.id,
        vout: chain.coinbase_tx_index,
      });
    }],

    // Alice spends the UTXO to the chain swap address
    fundSwapAddress: [
      'aliceUtxo',
      'createChainSwapAddress',
      'generateAliceKeyPair',
      (res, cbk) =>
    {
      return sendChainTokensTransaction({
        destination: res.createChainSwapAddress.p2wsh_address,
        private_key: res.generateAliceKeyPair.private_key,
        spend_transaction_id: res.aliceUtxo.transaction_id,
        spend_vout: res.aliceUtxo.vout,
        tokens: res.aliceUtxo.tokens,
      },
      cbk);
    }],

    // The swap funding transaction is mined
    mineFundingTx: ['fundSwapAddress', ({network, fundSwapAddress}, cbk) => {
      return mineTransaction({
        network,
        transaction: fundSwapAddress.transaction,
      },
      cbk);
    }],

    // Alice checks the height after funding
    getHeightAfterFunding: ['mineFundingTx', ({network}, cbk) => {
      return getBlockchainInfo({network}, cbk);
    }],

    // Alice makes a transaction to claim her refund too early
    tooEarlyRefundTx: ['getHeightAfterFunding', (res, cbk) => {
      return refundTransaction({
        current_block_height: res.getHeightAfterFunding.current_height,
        destination: res.createAliceAddress.p2wpkh_address,
        fee_tokens_per_vbyte: staticFeePerVirtualByte,
        private_key: res.generateAliceKeyPair.private_key,
        redeem_script: res.createChainSwapAddress.redeem_script,
        utxos: res.fundingTransactionUtxos.matching_outputs,
      },
      cbk);
    }],

    // Alice tries to claim her refund right away but hits `refund_too_early`
    broadcastEarlyRefundTx: ['tooEarlyRefundTx', (res, cbk) => {
      return broadcastTransaction({
        network: res.network,
        transaction: res.tooEarlyRefundTx.transaction,
      },
      err => {
        if (!err) {
          return cbk([errCode.local_err, 'Expected tx fails OP_CLTV check']);
        }

        return cbk();
      });
    }],

    // Bob never gets the preimage and claims his funds. Many blocks go by
    generateTimeoutBlocks: ['mineFundingTx', ({network}, cbk) => {
      return generateChainBlocks({
        network,
        blocks_count: swapTimeoutBlockCount,
      },
      cbk);
    }],

    // Grab the current height to use in the sweep tx
    getHeightForSweepTransaction: ['generateTimeoutBlocks', (res, cbk) => {
      return getBlockchainInfo({network: res.network}, cbk);
    }],

    // Alice picks up her funding utxos
    fundingTransactionUtxos: [
      'createChainSwapAddress',
      'fundSwapAddress',
      (res, cbk) =>
    {
      return outputScriptInTransaction({
        redeem_script: res.createChainSwapAddress.redeem_script,
        transaction: res.fundSwapAddress.transaction,
      },
      cbk);
    }],

    // Alice will claim her refunded tokens after the timeout
    sweepTransaction: [
      'createAliceAddress',
      'createChainSwapAddress',
      'fundingTransactionUtxos',
      'generateAliceKeyPair',
      'getHeightForSweepTransaction',
      'mineFundingTx',
      (res, cbk) =>
    {
      return refundTransaction({
        current_block_height: res.getHeightForSweepTransaction.current_height,
        destination: res.createAliceAddress.p2wpkh_address,
        fee_tokens_per_vbyte: staticFeePerVirtualByte,
        private_key: res.generateAliceKeyPair.private_key,
        redeem_script: res.createChainSwapAddress.redeem_script,
        utxos: res.fundingTransactionUtxos.matching_outputs,
      },
      cbk);
    }],

    // Mine the sweep transaction into a block
    mineSweepTransaction: ['sweepTransaction', (res, cbk) => {
      return mineTransaction({
        network: res.network,
        transaction: res.sweepTransaction.transaction,
      },
      cbk);
    }],
  },
  returnResult({of: 'network'}, cbk));
};

module.exports({}, (err, network) => {
  if (!!err) {
    console.log('REFUND SUCCESS ERROR', err);
  }

  stopChainDaemon({network}, (err, res) => {});

  console.log('REFUND SUCCESS TEST COMPLETE!');

  return;
});

