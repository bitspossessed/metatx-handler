const Web3 = require('web3')
const Transaction = require('ethereumjs-tx')
const generateKeypair = require('./generate-keypair')
const TxRelaySigner = require('./tx-relay-signer')
const SimpleSigner = require('./simple-signer')

class MetaTxHandler {
  constructor (relayerPrivKey, provider, txRelayAddress, txRelayABI, logger) {
    if (!relayerPrivKey) throw new Error('relayerPrivKey is required')
    this.privKey = relayerPrivKey
    this.txRelayAddress = txRelayAddress
    this.web3 = new Web3(provider)
    this.BN = this.web3.utils.BN
    this.Transaction = Transaction
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
    const nonce = await this.TxRelayContract.methods.getNonce(address).call()
    return nonce.toString(16)
  }

  initSimpleSigner () {
    const signer = new SimpleSigner(generateKeypair(this.privKey))
    return signer
  }

  getSenderKeyPair (senderPrivKey) {
    if (!senderPrivKey) throw new Error("sender's private key is required")
    return generateKeypair(senderPrivKey);
  }

  initTxRelaySigner (senderPrivKey, _whitelist) {
    const keyPair = this.getSenderKeyPair(senderPrivKey)
    const whitelist = _whitelist ? _whitelist : '0x0000000000000000000000000000000000000000'
    const signer = new TxRelaySigner(
      keyPair,
      this.txRelayAddress,
      keyPair.address,
      whitelist,
      this.TxRelayContract.options.jsonInterface
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

    let nonce
    try {
      nonce = await this.getRelayNonce(decodedTx.claimedAddress)
    } catch (error) {
      if (this.logger) {
        this.logger.error('Error on getRelayNonce')
        this.logger.error(error)
      } else {
        console.error('Error on getRelayNonce')
        console.error(error)
      }
      return false
    }
    if (metaNonce !== undefined && metaNonce > nonce) {
      nonce = metaNonce.toString()
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
        nonce
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
    console.log('in sign')
    console.log(relayNonce)
    let nonce
    if (!relayNonce && relayNonce !== 0) {
      console.log('not relay nonce branch')
      const sender = this.getSenderKeyPair(senderPrivKey)
      nonce = await this.getRelayNonce(sender.address)
    } else { nonce = relayNonce }
    console.log(nonce)
    console.log('test')
    const signer = this.initTxRelaySigner(senderPrivKey, whitelist)
    console.log('test2')
    txParams.nonce = this.web3.utils.toHex(nonce);
    console.log(txParams.nonce)
    const tx = new Transaction(txParams);
    console.log(tx)
    const rawTx = `0x${tx.serialize().toString('hex')}`;
    console.log('raw')
    console.log(rawTx)
    return new Promise((resolve, reject) => {
      signer.signRawTx(rawTx, (err, metaSignedTx) => {
        if (err) reject(err)
        const params = {
          metaNonce: txParams.nonce,
          metaSignedTx,
        };
        if (this.logger) {
          this.logger.info(params)
        } else {
          console.log(params);
        }
        resolve(params);
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
    // add some buffer to the limit
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

    if (!body.metaNonce) {
      throw { code: 400, message: 'metaNonce parameter missing' }
    }

    // support number or hexstring for metaNonce
    if (!body.metaNonce.startsWith('0x')) {
      console.log(body.metaNonce)
      body.metaNonce = this.web3.utils.toHex(body.metaNonce);
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
