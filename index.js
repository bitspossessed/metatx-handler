const { generators, signers } = require('eth-signer')
const TxRelaySigner = signers.TxRelaySigner
const SimpleSigner = signers.SimpleSigner
const Web3 = require('web3')
const Transaction = require('ethereumjs-tx')
const logger = require('./logger')

export default class MetaTxHandler {
  constructor (privKey, provider, txRelayAddress, txRelayABI, logger) {
    this.privKey = privKey
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
    const nonce = await this.TxRelayContract.methods.getNonce(address).call()
    return nonce.toString(16)
  }

  initSigner () {
    const signer = new SimpleSigner(generators.KeyPair.fromPrivateKey(this.privKey))
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
        logger.error('Error on TxRelaySigner.decodeMetaTx or getRelayerAddress')
        logger.error(error)
      } else {
        console.error('Error on TxRelaySigner.decodeMetaTx or getRelayerAddress')
        console.error(error)
      }

      return false
    }

    if (decodedTx.claimedAddress === '0x') {
      this.logger
        ? logger.info('no claimedAddress')
        : console.log('no claimedAddress')
      return false
    }

    let nonce
    try {
      nonce = await this.getRelayNonce(decodedTx.claimedAddress)
    } catch (error) {
      if (this.logger) {
        logger.error('Error on getRelayNonce')
        logger.error(error)
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
        ? logger.info(
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
        logger.error('Error on TxRelaySigner.isMetaSignatureValid')
        logger.error(error)
      } else {
        console.error('Error on TxRelaySigner.isMetaSignatureValid')
        console.error(error)
      }
      return false
    }
  }

  async signTx ({ txHex }) {
    if (!txHex) throw new Error('no txHex')
    const tx = new Transaction(Buffer.from(txHex, 'hex'))
    const signer = this.initSigner()
    const price = await this.web3.eth.getGasPrice()
    tx.gasPrice = new this.BN(price).toNumber()
    tx.nonce = await this.web3.eth.getTransactionCount(signer.getAddress())
    const estimatedGas = await this.estimateGas(tx, signer.getAddress())
    // add some buffer to the limit
    tx.gasLimit = estimatedGas.add(new this.BN(1000000))
    const rawTx = tx.serialize().toString('hex')
    return new Promise((resolve, reject) => {
      signer.signRawTx(rawTx, (error, signedRawTx) => {
        if (error) {
          reject(error)
        }
        resolve(signedRawTx)
      })
    })
  }

  async sendRawTransaction (signedRawTx) {
    if (!signedRawTx) throw new Error('no signedRawTx')

    if (!signedRawTx.startsWith('0x')) {
      signedRawTx = `0x${signedRawTx}`
    }
    const txHash = await this.web3.eth.sendSignedTransaction(signedRawTx)
    return txHash
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
      signedRawTx = await this.signTx({ txHex: body.metaSignedTx })
    } catch (error) {
      if (this.logger) {
        logger.error('Error signing transaction')
        logger.error(error)
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
        logger.error('Error on sendRawTransaction')
        logger.error(error)
      } else {
        console.error('Error on sendRawTransaction')
        console.error(error)
      }
      throw { code: 500, message: error.message }
    }
  }
}

module.exports = MetaTxHandler
