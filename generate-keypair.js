// thanks to https://github.com/ConsenSys/eth-signer/blob/master/lib/generators/key_pair.js

var util = require("ethereumjs-util");
var secp256k1 = util.secp256k1;

function hex0x(buffer) {
  return util.addHexPrefix(buffer.toString('hex'));
}

function generateKeypair(privateKey) {
  if (!Buffer.isBuffer(privateKey)) {
    privateKey = new Buffer(privateKey,'hex');
  }
  var publicKey = util.privateToPublic(privateKey);
  return {
        privateKey: hex0x(privateKey),
        publicKey: hex0x(publicKey),
        address: hex0x(util.pubToAddress(publicKey))
      };
}

module.exports = generateKeypair;