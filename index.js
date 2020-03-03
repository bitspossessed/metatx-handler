const { generators, signers } = require('eth-signer')
const TxRelaySigner = signers.TxRelaySigner
const SimpleSigner = signers.SimpleSigner
const Web3 = require('web3')
const Transaction = require('ethereumjs-tx')

class MetaTxHandler {
  constructor (relayerPrivKey, provider, txRelayAddress, txRelayABI, logger) {
    if (!relayerPrivKey) throw new Error('relayerPrivKey is required')
    this.privKey = relayerPrivKey
    this.txRelayAddress = txRelayAddress
    this.web3 = new Web3(provider)
    this.BN = this.web3.utils.BN
    this.TxRelayContract = new this.web3.eth.Contract(
      txRelayABI,
      txRelayAddress
    )
    this.logger = logger
  }

  getRelayerAddress () {
    return this.TxRelayContract.options.address
  }

  async getRelayNonce (address) {
    if (!address) throw new Error('no address')
    try {
      const nonce = await this.TxRelayContract.methods.getNonce(address).call()
    } catch (err) {
      console.log(err)
    }
    return nonce.toString(16)
  }

  initSimpleSigner () {
    const signer = new SimpleSigner(generators.KeyPair.fromPrivateKey(this.privKey))
    return signer
  }

  getSenderKeyPair (senderPrivKey) {
    if (!senderPrivKey) throw new Error("sender's private key is required")
    return generators.KeyPair.fromPrivateKey(senderPrivKey);
  }

  initTxRelaySigner (senderPrivKey, _whitelist) {
    const keyPair = this.getSenderKeyPair(senderPrivKey)
    const whitelist = _whitelist ? _whitelist : '0x0000000000000000000000000000000000000000'
    const signer = new TxRelaySigner(
      keyPair,
      this.txRelayAddress,
      keyPair.address,
      whitelist
    );
    return signer
  }

  async estimateGas (tx, from) {
    if (!tx) throw new Error('no tx object')

    const txCopy = {
      nonce: `0x${tx.nonce.toString('hex') || 0}`,
      gasPrice: `0x${tx.gasPrice.toString('hex')}`,
      to: `0x${tx.to.toString('hex')}`,
      value: `0x${tx.value.toString('hex') || 0}`,
      data: `0x${tx.data.toString('hex')}`,
      from
    }
    let price = 3000000
    try {
      price = await this.web3.eth.estimateGas(txCopy)
    } catch (err) {
      throw err
    }
    return new this.BN(price)
  }

  async isMetaSignatureValid (metaSignedTx, metaNonce) {
    if (!metaSignedTx) throw new Error('no metaSignedTx')
    let decodedTx
    let relayerAddress
    try {
      relayerAddress = await this.getRelayerAddress()
      decodedTx = TxRelaySigner.decodeMetaTx(metaSignedTx)
    } catch (error) {
      if (this.logger) {
        this.logger.error('Error on TxRelaySigner.decodeMetaTx or getRelayerAddress')
        this.logger.error(error)
      } else {
        console.error('Error on TxRelaySigner.decodeMetaTx or getRelayerAddress')
        console.error(error)
      }

      return false
    }

    if (decodedTx.claimedAddress === '0x') {
      this.logger
        ? this.logger.info('no claimedAddress')
        : console.log('no claimedAddress')
      return false
    }

    try {
      this.logger
        ? this.logger.info(
          `trying to validate metasig, relayerAddress is ${relayerAddress}`
        )
        : console.log(
          `trying to validate metasig, relayerAddress is ${relayerAddress}`
        )
      const validMetaSig = TxRelaySigner.isMetaSignatureValid(
        relayerAddress,
        decodedTx,
        metaNonce
      )
      return validMetaSig
    } catch (error) {
      if (this.logger) {
        this.logger.error('Error on TxRelaySigner.isMetaSignatureValid')
        this.logger.error(error)
      } else {
        console.error('Error on TxRelaySigner.isMetaSignatureValid')
        console.error(error)
      }
      return false
    }
  }

  async signMetaTx (txParams, senderPrivKey, relayNonce, whitelist) {
    let nonce
    if (!relayNonce) {
      const sender = this.getSenderKeyPair(senderPrivKey)
      nonce = await this.getRelayNonce(sender.address)
    } else { nonce = relayNonce }
    const signer = this.initTxRelaySigner(senderPrivKey, whitelist)
    txParams.nonce = this.web3.utils.toHex(nonce);
    const tx = new Transaction(txParams);
    const rawTx = `0x${tx.serialize().toString('hex')}`;
    return new Promise((resolve, reject) => {
      signer.signRawTx(rawTx, (err, metaSignedTx) => {
        if (err) reject(err)
        // if (this.logger) {
        //   this.logger.info(params)
        // } else {
        //   console.log(params);
        // }
        resolve(metaSignedTx);
      });
    });
  };

  async signRelayerTx (txHex) {
    if (!txHex) throw new Error('no txHex')
    const tx = new Transaction(Buffer.from(txHex, 'hex'))
    const signer = this.initSimpleSigner()
    const price = await this.web3.eth.getGasPrice()
    tx.gasPrice = new this.BN(price).toNumber()
    tx.nonce = await this.web3.eth.getTransactionCount(signer.getAddress())
    const estimatedGas = await this.estimateGas(tx, signer.getAddress())
    tx.gasLimit = estimatedGas.add(new this.BN(1000000))
    const rawTx = tx.serialize().toString('hex')
    return new Promise((resolve, reject) => {
      signer.signRawTx(rawTx, (error, signedRawTx) => {
        if (error) reject(error)
        resolve(signedRawTx)
      })
    })
  }

  async sendRawTransaction (signedRawTx) {
    if (!signedRawTx) throw new Error('no signedRawTx')

    if (!signedRawTx.startsWith('0x')) {
      signedRawTx = `0x${signedRawTx}`
    }
    return new Promise((resolve, reject) => {
      this.web3.eth.sendSignedTransaction(signedRawTx, (error, txHash) => {
        if (error) reject(error)
        resolve(txHash)
      })
    })
  }

  async handle (req) {
    const body = req.body || JSON.parse(req.body)

    if (!body.metaSignedTx) {
      throw { code: 400, message: 'metaSignedTx parameter missing' }
    }

    // support hex strings starting with 0x
    if (body.metaSignedTx.startsWith('0x')) {
      body.metaSignedTx = body.metaSignedTx.slice(2)
    }

    // Check if metaTx signature is valid
    if (!(await this.isMetaSignatureValid(body.metaSignedTx, body.metaNonce))) {
      throw { code: 403, message: 'MetaTx signature invalid' }
    }

    let signedRawTx
    try {
      signedRawTx = await this.signRelayerTx(body.metaSignedTx)
    } catch (error) {
      if (this.logger) {
        this.logger.error('Error signing transaction')
        this.logger.error(error)
      } else {
        console.error('Error signing transaction')
        console.error(error)
      }
      throw { code: 500, message: error.message }
    }

    try {
      const txHash = await this.sendRawTransaction(signedRawTx)
      return txHash
    } catch (error) {
      if (this.logger) {
        this.logger.error('Error on sendRawTransaction')
        this.logger.error(error)
      } else {
        console.error('Error on sendRawTransaction')
        console.error(error)
      }
      throw { code: 500, message: error.message }
    }
  }
}

module.exports = MetaTxHandler
