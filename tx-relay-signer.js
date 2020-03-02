// thanks to https://github.com/ConsenSys/eth-signer/blob/master/lib/tx_relay_signer.js

var Transaction = require('ethereumjs-tx');
var util = require("ethereumjs-util");
var abi = require('ethereumjs-abi')
var web3 = require('web3')

function encodeFunctionTxData(functionName, types, args) {

  var fullName = functionName + '(' + types.join() + ')';
  var w = new web3();
  var signature = w.eth.abi.encodeFunctionSignature(fullName);
  var dataHex = signature + abi.rawEncode(types, args);

  return dataHex;
}

function decodeFunctionTxData(data, types) {
  var bytes = data.slice(8);

  return abi.rawDecode(types, bytes);
}

function getTypesFromAbi(abi, functionName) {

  function matchesFunctionName(json) {
    return (json.name === functionName && json.type === 'function');
  }

  function getTypes(json) {
    return json.type;
  }

  var funcJson = abi.filter(matchesFunctionName)[0];

  return (funcJson.inputs).map(getTypes);
}

function add0x(input) {
  if (typeof(input) !== 'string') {
    return input;
  }
  else if (input.length < 2 || input.slice(0,2) !== '0x') {
    return '0x' + input;
  }
  else {
    return input;
  }
}

function functionTx(abi, functionName, args, txObject) {
  // txObject contains gasPrice, gasLimit, nonce, to, value

  var types = getTypesFromAbi(abi, functionName);
  var txData = encodeFunctionTxData(functionName, types, args);

  var txObjectCopy = {};
  txObjectCopy.to = add0x(txObject.to);
  txObjectCopy.gasPrice = add0x(txObject.gasPrice);
  txObjectCopy.gasLimit = add0x(txObject.gasLimit);
  txObjectCopy.nonce = add0x(txObject.nonce);
  txObjectCopy.data = add0x(txData);
  txObjectCopy.value = add0x(txObject.value);

  return (new Transaction(txObjectCopy)).serialize().toString('hex');
}

var TxRelaySigner = function(keypair, txRelayAddress, txSenderAddress, whitelistOwner, txRelayAbi) {
  this.keypair = keypair;
  this.txRelayAddress = txRelayAddress;
  this.txSenderAddress = txSenderAddress;
  this.whitelistOwner = whitelistOwner;
  this.txRelayAbi = txRelayAbi;
}

TxRelaySigner.prototype.getAddress = function() {
  return this.keypair.address;
}

TxRelaySigner.prototype.signRawTx = function(rawTx, callback) {
  var rawTx = util.stripHexPrefix(rawTx);
  var txCopy = new Transaction(Buffer.from(rawTx, 'hex'));
  // console.log(txCopy)

  var nonce = txCopy.nonce.toString('hex');
  var to = txCopy.to.toString('hex');
  var data = txCopy.data.toString('hex');
  if (!nonce) {
    // if the buffer is empty nonce should be zero
    nonce = '0';
  }

  // // Tight packing, as Solidity sha3 does
  // var hashInput = '0x1900' + util.stripHexPrefix(this.txRelayAddress)
  //                 + util.stripHexPrefix(this.whitelistOwner) + pad(nonce) + to + data;
  // var hash = solsha(hashInput)

  console.log('prehash')
  console.log(to)
  var hash = abi.soliditySHA3(
    [ "address", "address", "uint", "address", "string" ],
    [ this.txRelayAddress, this.whitelistOwner, new web3.utils.toBN(nonce), util.addHexPrefix(to), data]).toString('hex')
  console.log('hash')
  console.log(hash)
  
//     new BN("43989fb883ba8111221e89123897538475893837", 16), 0, 10000, 1448075779 ]
// ).toString('hex')

  var sig = this.signMsgHash(hash);

  console.log(sig)

  var wrapperTx = {
    "gasPrice": txCopy.gasPrice,
    "gasLimit": txCopy.gasLimit,
    "value": 0,
    "to": this.txRelayAddress,
    "from": this.txSenderAddress,
  };

  console.log('txRelayAbi')
  console.log(this.txRelayAbi)
  var rawMetaSignedTx = functionTx(this.txRelayAbi, "relayMetaTx",
    [ sig.v,
      util.addHexPrefix(sig.r.toString('hex')),
      util.addHexPrefix(sig.s.toString('hex')),
      util.addHexPrefix(to),
      util.addHexPrefix(data),
      util.addHexPrefix(this.whitelistOwner)
    ], wrapperTx)

  callback(null, rawMetaSignedTx);
}

TxRelaySigner.prototype.signMsgHash = function(msgHash) {
  return util.ecsign(Buffer.from(util.stripHexPrefix(msgHash), 'hex'), Buffer.from(util.stripHexPrefix(this.keypair.privateKey), 'hex'));
}

TxRelaySigner.decodeMetaTx = function(rawMetaSignedTx) {
  var tx = new Transaction(Buffer.from(rawMetaSignedTx, 'hex'));
  var txData = tx.data.toString('hex');
  var types = getTypesFromAbi(this.txRelayAbi, "relayMetaTx");
  var params = decodeFunctionTxData(txData, types);

  decodedMetaTx = {}
  decodedMetaTx.v = params[0].toNumber();
  decodedMetaTx.r = Buffer.from(util.stripHexPrefix(params[1]), 'hex');
  decodedMetaTx.s = Buffer.from(util.stripHexPrefix(params[2]), 'hex');
  decodedMetaTx.to = util.stripHexPrefix(params[3]);
  decodedMetaTx.data = util.stripHexPrefix(params[4]);
  decodedMetaTx.whitelistOwner = util.stripHexPrefix(params[5]);
  // signed tx data must start with the address of the meta sender
  decodedMetaTx.claimedAddress = '0x' + decodedMetaTx.data.slice(32, 72);

  return decodedMetaTx;
}

TxRelaySigner.isMetaSignatureValid = function(txRelayAddress, decodedMetaTx, nonce) {
  if (typeof nonce !== 'string') throw new Error('nonce must be a string')
  // var hashInput = '0x1900' + util.stripHexPrefix(txRelayAddress) + util.stripHexPrefix(decodedMetaTx.whitelistOwner)
  //                 + pad(nonce) + decodedMetaTx.to + decodedMetaTx.data
  // var msgHash = web3.utils.soliditySha3(hashInput);
  var hash = abi.soliditySHA3(
    [ "address", "address", "uint", "address", "string" ],
    [ txRelayAddress, decodedMetaTx.whitelistOwner, new web3.utils.toBN(nonce), decodedMetaTx.to, decodedMetaTx.data]).toString('hex')
  var pubkey = util.ecrecover(Buffer.from(util.stripHexPrefix(msgHash), 'hex'), decodedMetaTx.v, decodedMetaTx.r, decodedMetaTx.s);
  var address = '0x' + util.pubToAddress(pubkey).toString('hex');
  return address === decodedMetaTx.claimedAddress;
}

// function pad(n) {
//   if (n.startsWith('0x')) {
//     n = util.stripHexPrefix(n);
//   }
//   return leftPad(n, '64', '0');
// }

module.exports = TxRelaySigner


