# metatx-server

Exposes a class MetaTxHandler that should be instantiated like this:

```
const metaTxHandler = new MetaTxHandler(
  relayerPrivKey,     // required arg. The private key that will relay transactions
  provider,           // required arg. Your web3 provider
  txRelayAddress,     // required arg. The address of your relayer contract
  txRelayABI,         // required arg. The abi of your relayer contract
  logger              // optional arg. Your logger, if you use one. Should have levels info and error
)
```

Methods:


`getRelayerAddress` => returns the given relayer address

`getRelayNonce (address)` => returns the nonce held in the relayer contract of the given address. A relayer nonce is required to prevent replay attacks.

`initSimpleSigner` => generates an eth-signer signer from the relayer private key given in the contructor

`getSenderKeyPair (senderPrivKey)` => generates a keypair from any given private key

`initTxRelaySigner (senderPrivKey, _whitelist)` => generates an eth-signer signer for the given sender private key. `senderPrivKey` is required, `whitelist` is optional.

`estimateGas (tx, txSender)` =>  estimates gas cost of a transaction, formatted in rlp. 

`isMetaSignatureValid (metaSignedTx, metaNonce)` => verified that a meta signature is valid. `metaSignedTx` is a signed meta transaction and `metaNonce` is the nonce of the sender as of the relayer contract.

`signMetaTx (txParams, senderPrivKey, relayNonce, whitelist)` => prepares a signed meta transaction. `txParams` is an object that can be constructed like this: 

```
const tx = {
  from: address,
  to: contractAddress,
  value: 0,
  data: Contract.methods.methodName(methodArgs).encodeABI()
};
```

`senderPrivKey` is the private key of the from address is `txParams`. `relayNonce` is optional, and will default to the relayer address set in the constructor. `whitelist` is also optional.

`signRelayerTx (txHex)` => Signs a meta transaction for forwarding to the relayer contract. `txHex` should be the signed meta tx in rlp encoding. Also estimates the gas price needed to execute the transaction.

'sendRawTransaction (signedRawTx)' => signes and sends a raw transaction to `provider` 

`handle (req)` => Fully handles a request to the server to process a meta transaction. Can be used like this:

```
const relay = async (req, res) => {
  try {
    const result = await MetaTxHandler.handle(req)
    return res.status(200).json({ result })
  } catch (err) {
    return res.status(error.code).json({ error: error.message })
  }
```
