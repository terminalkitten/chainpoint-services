// load all environment variables into env object
const env = require('./lib/parse-env.js')('cal')

const async = require('async')
const _ = require('lodash')
const MerkleTools = require('merkle-tools')
const amqp = require('amqplib')
const uuidv1 = require('uuid/v1')
const crypto = require('crypto')
const calendarBlock = require('./lib/models/CalendarBlock.js')
const cnsl = require('consul')
const utils = require('./lib/utils.js')

// TweetNaCl.js
// see: http://ed25519.cr.yp.to
// see: https://github.com/dchest/tweetnacl-js#signatures
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

// Pass SIGNING_SECRET_KEY as Base64 encoded bytes
const signingSecretKeyBytes = nacl.util.decodeBase64(env.SIGNING_SECRET_KEY)
const signingKeypair = nacl.sign.keyPair.fromSecretKey(signingSecretKeyBytes)

const zeroStr = '0000000000000000000000000000000000000000000000000000000000000000'

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// An array of all Merkle tree roots from aggregators needing
// to be processed. Will be filled as new roots arrive on the queue.
let AGGREGATION_ROOTS = []

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The latest NIST data
// This value is updated from consul events as changes are detected
let nistLatest = null

// An array of all Btc-Mon messages received and awaiting processing
let BTC_MON_MESSAGES = []

// Variables holding the configured interval functions
// The variables are set when intervals are created
// The variables are used when deleting a timeout, if requested
let anchorBtcInterval = null
let anchorEthInterval = null

// pull in variables defined in shared CalendarBlock module
let sequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock

let consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
console.log('Consul connection established')

// Calculate the hash of the signing public key bytes
// to allow lookup of which pubkey was used to sign
// a block. Handles different organizations signing blocks
// with different keys and key rotation by those orgs.
// When a Base64 pubKey is published publicly it should also
// be accompanied by this hash of its bytes to serve
// as a fingerprint.
let calcSigningPubKeyHash = (pubKey) => {
  return crypto.createHash('sha256').update(pubKey).digest('hex')
}
const signingPubKeyHash = calcSigningPubKeyHash(signingKeypair.publicKey)

// Calculate a deterministic block hash and return a Buffer hash value
let calcBlockHash = (block) => {
  let prefixString = `${block.id.toString()}:${block.time.toString()}:${block.version.toString()}:${block.stackId.toString()}:${block.type.toString()}:${block.dataId.toString()}`
  let prefixBuffer = Buffer.from(prefixString, 'utf8')
  let dataValBuffer = Buffer.from(block.dataVal, 'hex')
  let prevHashBuffer = Buffer.from(block.prevHash, 'hex')

  return crypto.createHash('sha256').update(Buffer.concat([
    prefixBuffer,
    dataValBuffer,
    prevHashBuffer
  ])).digest()
}

// Calculate a base64 encoded signature over the block hash
let calcBlockHashSig = (bh) => {
  return nacl.util.encodeBase64(nacl.sign(bh, signingKeypair.secretKey))
}

// The write function used by all block creation functions to write to calendar blockchain
let writeBlockAsync = async (height, type, dataId, dataVal, prevHash, friendlyName) => {
  let b = {}
  b.id = height
  b.time = Math.trunc(Date.now() / 1000)
  b.version = 1
  b.stackId = env.CHAINPOINT_STACK_ID
  b.type = type
  b.dataId = dataId
  b.dataVal = dataVal
  b.prevHash = prevHash

  let bh = calcBlockHash(b)
  b.hash = bh.toString('hex')

  // pre-pend Base64 signature with truncated chars of SHA256 hash of the
  // pubkey bytes, joined with ':', to allow for lookup of signing pubkey.
  b.sig = [signingPubKeyHash.slice(0, 12), calcBlockHashSig(bh)].join(':')

  try {
    let block = await CalendarBlock.create(b)
    console.log(`${friendlyName} BLOCK : id : ${block.get({ plain: true }).id}`)
    return block.get({ plain: true })
  } catch (error) {
    throw new Error(`${friendlyName} BLOCK create error: ${error.message} : ${error.stack}`)
  }
}

let createGenesisBlockAsync = async () => {
  return await writeBlockAsync(0, 'gen', '0', zeroStr, zeroStr, 'GENESIS')
}

let createCalendarBlockAsync = async (root) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: 'id DESC' })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      return await writeBlockAsync(newId, 'cal', newId.toString(), root.toString(), prevBlock.hash, 'CAL')
    } else {
      throw new Error('could not write block, no genesis block found')
    }
  } catch (error) {
    throw new Error('could not write block')
  }
}

let createNistBlockAsync = async (nistDataObj) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: 'id DESC' })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      let dataId = nistDataObj.split(':')[0].toString() // the epoch timestamp for this NIST entry
      let dataVal = nistDataObj.split(':')[1].toString()  // the hex value for this NIST entry
      return await writeBlockAsync(newId, 'nist', dataId, dataVal, prevBlock.hash, 'NIST')
    } else {
      throw new Error('could not write block, no genesis block found')
    }
  } catch (error) {
    throw new Error('could not write block')
  }
}

let createBtcAnchorBlockAsync = async (root) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: 'id DESC' })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      console.log(newId, 'btc-a', '', root.toString(), prevBlock.hash, 'BTC-ANCHOR')
      return await writeBlockAsync(newId, 'btc-a', '', root.toString(), prevBlock.hash, 'BTC-ANCHOR')
    } else {
      throw new Error('could not write block, no genesis block found')
    }
  } catch (error) {
    throw new Error('could not write block')
  }
}

let createBtcConfirmBlockAsync = async (height, root, callback) => {
  // Find the last block written so we can incorporate its hash as prevHash
  // in the new block and increment its block ID by 1.
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: 'id DESC' })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      return await writeBlockAsync(newId, 'btc-c', height.toString(), root.toString(), prevBlock.hash, 'BTC-CONFIRM')
    } else {
      throw new Error('could not write block, no genesis block found')
    }
  } catch (error) {
    throw new Error('could not write block')
  }
}

/**
* Parses a message and performs the required work for that message
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
function processMessage (msg) {
  if (msg !== null) {
    // determine the source of the message and handle appropriately
    switch (msg.properties.type) {
      case 'aggregator':
        consumeAggRootMessage(msg)
        break
      case 'btctx':
        if (env.ANCHOR_BTC === 'enabled') {
          // Consumes a tx  message from the btctx service
          consumeBtcTxMessage(msg)
        } else {
          // BTC anchoring has been disabled, ack message and do nothing
          amqpChannel.ack(msg)
        }
        break
      case 'btcmon':
        if (env.ANCHOR_BTC === 'enabled') {
          // Consumes a tx message from the btctx service
          consumeBtcMonMessage(msg)
        } else {
          // BTC anchoring has been disabled, ack message and do nothing
          amqpChannel.ack(msg)
        }
        break
      default:
        // This is an unknown state type
        console.error('Unknown state type', msg.properties.type)
    }
  }
}

function consumeAggRootMessage (msg) {
  if (msg !== null) {
    let rootObj = JSON.parse(msg.content.toString())

    // add msg to the root object so that we can ack it during the finalize process for this root object
    rootObj.msg = msg
    AGGREGATION_ROOTS.push(rootObj)
  }
}

function consumeBtcTxMessage (msg) {
  if (msg !== null) {
    let btcTxObj = JSON.parse(msg.content.toString())

    async.series([
      (callback) => {
        // queue up message containing updated proof state bound for proof state service
        let stateObj = {}
        stateObj.anchor_agg_id = btcTxObj.anchor_agg_id
        stateObj.btctx_id = btcTxObj.btctx_id
        let anchorAggRoot = btcTxObj.anchor_agg_root
        let btctxBody = btcTxObj.btctx_body
        let prefix = btctxBody.substr(0, btctxBody.indexOf(anchorAggRoot))
        let suffix = btctxBody.substr(btctxBody.indexOf(anchorAggRoot) + anchorAggRoot.length)
        stateObj.btctx_state = {}
        stateObj.btctx_state.ops = [
          { l: prefix },
          { r: suffix },
          { op: 'sha-256-x2' }
        ]

        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btctx' },
          (err, ok) => {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message nacked')
              return callback(err)
            } else {
              // New message has been published
              console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message acked')
              return callback(null)
            }
          })
      },
      // inform btc-mon of new tx_id to watch, queue up message bound for btc mon
      (callback) => {
        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCMON_QUEUE, Buffer.from(JSON.stringify({ tx_id: btcTxObj.btctx_id })), { persistent: true },
          (err, ok) => {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message nacked')
              return callback(err)
            } else {
              // New message has been published
              console.log(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message acked')
              return callback(null)
            }
          })
      }
    ], (err, results) => {
      if (err) {
        amqpChannel.nack(msg)
        console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[btctx] consume message nacked')
      } else {
        amqpChannel.ack(msg)
        console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[btctx] consume message acked')
      }
    })
  }
}

function consumeBtcMonMessage (msg) {
  if (msg !== null) {
    BTC_MON_MESSAGES.push(msg)
    btcConfirmLock.acquire()
  }
}

/**
 * Converts proof path array output from the merkle-tools package
 * to a Chainpoint v3 ops array
 *
 * @param {proof object array} proof - The proof array generated by merkle-tools
 * @param {string} op - The hash type performed throughout merkle tree construction (sha-256, sha-512, sha-256-x2, etc.)
 * @returns {ops object array}
 */
function formatAsChainpointV3Ops (proof, op) {
  proof = proof.map((item) => {
    if (item.left) {
      return { l: item.left }
    } else {
      return { r: item.right }
    }
  })
  let ChainpointV3Ops = []
  for (let x = 0; x < proof.length; x++) {
    ChainpointV3Ops.push(proof[x])
    ChainpointV3Ops.push({ op: op })
  }
  return ChainpointV3Ops
}

// Take work off of the AGGREGATION_ROOTS array and build Merkle tree
let generateCalendarTree = () => {
  let rootsForTree = AGGREGATION_ROOTS.splice(0)

  let treeDataObj = null
  // create merkle tree only if there is at least one root to process
  if (rootsForTree.length > 0) {
    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // get root values from root objects
    let leaves = rootsForTree.map((rootObj) => {
      return rootObj.agg_root
    })

    // Add every root in rootsForTree to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    // Collect and store the Merkle root,
    // and proofs in an array where finalize() can find it
    treeDataObj = {}
    treeDataObj.cal_root = merkleTools.getMerkleRoot()

    let treeSize = merkleTools.getLeafCount()
    let proofData = []
    for (let x = 0; x < treeSize; x++) {
      // push the agg_id and corresponding proof onto the array
      let proofDataItem = {}
      proofDataItem.agg_id = rootsForTree[x].agg_id
      proofDataItem.agg_msg = rootsForTree[x].msg
      proofDataItem.agg_hash_count = rootsForTree[x].agg_hash_count
      let proof = merkleTools.getProof(x)
      proofDataItem.proof = formatAsChainpointV3Ops(proof, 'sha-256')
      proofData.push(proofDataItem)
    }
    treeDataObj.proofData = proofData
    console.log('rootsForTree length : %s', rootsForTree.length)
  }
  return treeDataObj
}

// Write tree to calendar block DB and also to proof state service via RMQ
let persistCalendarTreeAsync = async (treeDataObj) => {
  // Store Merkle root of calendar in DB and chain to previous calendar entries
  let block = await createCalendarBlockAsync(treeDataObj.cal_root.toString('hex'))
  async.waterfall([
    async.constant(block),
    // queue proof state messages for each aggregation root in the tree
    (block, callback) => {
      // for each aggregation root, queue up message containing
      // updated proof state bound for proof state service
      async.each(treeDataObj.proofData, (proofDataItem, eachCallback) => {
        let stateObj = {}
        stateObj.agg_id = proofDataItem.agg_id
        stateObj.agg_hash_count = proofDataItem.agg_hash_count
        stateObj.cal_id = block.id
        stateObj.cal_state = {}
        // add ops connecting agg_root to cal_root
        stateObj.cal_state.ops = proofDataItem.proof
        // add ops extending proof path beyond cal_root to calendar block's block_hash
        stateObj.cal_state.ops.push({ l: `${block.id}:${block.time}:${block.version}:${block.stackId}:${block.type}:${block.dataId}` })
        stateObj.cal_state.ops.push({ r: block.prevHash })
        stateObj.cal_state.ops.push({ op: 'sha-256' })

        // Build the anchors uris using the locations configured in CHAINPOINT_BASE_URI
        let BASE_URIS = [env.CHAINPOINT_BASE_URI]
        let uris = []
        for (let x = 0; x < BASE_URIS.length; x++) uris.push(`${BASE_URIS[x]}/calendar/${block.id}/hash`)
        stateObj.cal_state.anchor = {
          anchor_id: block.id,
          uris: uris
        }

        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'cal' },
          (err, ok) => {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[cal] publish message nacked')
              return eachCallback(err)
            } else {
              // New message has been published
              console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[cal] publish message acked')
              return eachCallback(null)
            }
          })
      }, (err) => {
        if (err) {
          return callback(err)
        } else {
          let messages = treeDataObj.proofData.map((proofDataItem) => {
            return proofDataItem.agg_msg
          })
          return callback(null, messages)
        }
      })
    }
  ], (err, messages) => {
    // messages contains an array of agg_msg objects
    if (err) {
      _.forEach(messages, (message) => {
        // nack consumption of all original hash messages part of this aggregation event
        if (message !== null) {
          amqpChannel.nack(message)
          console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[aggregator] consume message nacked')
        }
      })
      throw new Error(err)
    } else {
      _.forEach(messages, (message) => {
        if (message !== null) {
          // ack consumption of all original hash messages part of this aggregation event
          amqpChannel.ack(message)
          console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[aggregator] consume message acked')
        }
      })
    }
  })
}

// Aggregate all block hashes on chain since last BTC anchor block, add new
// BTC anchor block to calendar, add new proof state entries, anchor root
let aggregateAndAnchorBTC = (lastBtcAnchorBlockId, anchorCallback) => {
  async.waterfall([
    async (wfCallback) => {
      // Retrieve calendar blocks since last anchor block
      if (!lastBtcAnchorBlockId) lastBtcAnchorBlockId = -1
      try {
        let blocks = await CalendarBlock.findAll({ where: { id: { $gt: lastBtcAnchorBlockId } }, attributes: ['id', 'type', 'hash'], order: 'id ASC' })
        return wfCallback(null, blocks)
      } catch (error) {
        return wfCallback(error)
      }
    },
    async (blocks, wfCallback) => {
      // Build merkle tree with block hashes
      let leaves = blocks.map((blockObj) => {
        return blockObj.hash
      })

      // clear the merkleTools instance to prepare for a new tree
      merkleTools.resetTree()

      // Add every blockHash in blocks to new Merkle tree
      merkleTools.addLeaves(leaves)
      merkleTools.makeTree()

      // get the total count of leaves in this aggregation
      let treeSize = merkleTools.getLeafCount()

      let treeData = {}
      treeData.anchor_agg_id = uuidv1()
      treeData.anchor_agg_root = merkleTools.getMerkleRoot().toString('hex')

      let proofData = []
      for (let x = 0; x < treeSize; x++) {
        // for calendar type blocks only, push the cal_id and corresponding proof onto the array
        if (blocks[x].type === 'cal') {
          let proofDataItem = {}
          proofDataItem.cal_id = blocks[x].id
          let proof = merkleTools.getProof(x)
          proofDataItem.proof = formatAsChainpointV3Ops(proof, 'sha-256')
          proofData.push(proofDataItem)
        }
      }
      treeData.proofData = proofData

      console.log('blocks length : %s', blocks.length)

      // if the amqp channel is null (closed), processing should not continue, defer to next interval
      if (amqpChannel === null) return

      // Create new btc anchor block with resulting tree root
      try {
        let block = await createBtcAnchorBlockAsync(treeData.anchor_agg_root)
        return wfCallback(null, treeData, block)
      } catch (error) {
        return wfCallback('createBtcAnchorBlock error - ' + error)
      }
    },
    (treeData, newBlock, wfCallback) => {
      // For each calendar record block in the tree, add proof state
      // item containing proof ops from block_hash to anchor_agg_root
      async.series([
        (seriesCallback) => {
          // for each calendar block hash, queue up message containing updated
          // proof state bound for proof state service
          async.each(treeData.proofData, (proofDataItem, eachCallback) => {
            let stateObj = {}
            stateObj.cal_id = proofDataItem.cal_id
            stateObj.anchor_agg_id = treeData.anchor_agg_id
            stateObj.anchor_agg_state = {}
            stateObj.anchor_agg_state.ops = proofDataItem.proof

            amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'anchor_agg' },
              (err, ok) => {
                if (err !== null) {
                  // An error as occurred publishing a message
                  console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[anchor_agg] publish message nacked')
                  return eachCallback(err)
                } else {
                  // New message has been published
                  console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[anchor_agg] publish message acked')
                  return eachCallback(null)
                }
              })
          }, (err) => {
            if (err) {
              console.error('Anchor aggregation had errors.')
              return seriesCallback(err)
            } else {
              console.log('Anchor aggregation complete')
              return seriesCallback(null)
            }
          })
        },
        (seriesCallback) => {
          // Create anchor_agg message data object for anchoring service(s)
          let anchorData = {
            anchor_agg_id: treeData.anchor_agg_id,
            anchor_agg_root: treeData.anchor_agg_root
          }

          // Send anchorData to the btc tx service for anchoring
          amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCTX_QUEUE, Buffer.from(JSON.stringify(anchorData)), { persistent: true },
            (err, ok) => {
              if (err !== null) {
                console.error(env.RMQ_WORK_OUT_BTCTX_QUEUE, 'publish message nacked')
                return seriesCallback(err)
              } else {
                console.log(env.RMQ_WORK_OUT_BTCTX_QUEUE, 'publish message acked')
                return seriesCallback(null)
              }
            })
        }
      ], (err) => {
        if (err) return wfCallback(err)
        console.log('aggregateAndAnchorBTC process complete.')
        return wfCallback(null)
      })
    }
  ], (err) => {
    if (err) return anchorCallback(err)
    return anchorCallback(null)
  })
}

let aggregateAndAnchorETH = (lastEthAnchorBlockId, anchorCallback) => {
  console.log('TODO aggregateAndAnchorETH()')
  return anchorCallback(null)
}

// Each of these locks must be defined up front since event handlers
// need to be registered for each. They are all effectively locking the same
// resource since they share the same CALENDAR_LOCK_KEY. The value is
// purely informational and allows you to see which entity is currently
// holding a lock in the Consul admin web app.
//
// See also : https://github.com/hashicorp/consul/blob/master/api/lock.go#L21
//
var lockOpts = {
  key: env.CALENDAR_LOCK_KEY,
  lockwaittime: '60s',
  lockwaittimeout: '60s',
  lockretrytime: '100ms',
  session: {
    behavior: 'delete',
    checks: ['serfHealth'],
    lockdelay: '1ms',
    name: 'calendar-blockchain-lock',
    ttl: '30s'
  }
}

let genesisLock = consul.lock(_.merge({}, lockOpts, { value: 'genesis' }))
let calendarLock = consul.lock(_.merge({}, lockOpts, { value: 'calendar' }))
let nistLock = consul.lock(_.merge({}, lockOpts, { value: 'nist' }))
let btcAnchorLock = consul.lock(_.merge({}, lockOpts, { value: 'btc-anchor' }))
let btcConfirmLock = consul.lock(_.merge({}, lockOpts, { value: 'btc-confirm' }))
let ethAnchorLock = consul.lock(_.merge({}, lockOpts, { value: 'eth-anchor' }))
let ethConfirmLock = consul.lock(_.merge({}, lockOpts, { value: 'eth-confirm' }))

function registerLockEvents (lock, lockName, acquireFunction) {
  lock.on('acquire', () => {
    console.log(`${lockName} acquired`)
    acquireFunction()
  })

  lock.on('error', (err) => {
    console.log(`${lockName} error - ${err}`)
  })

  lock.on('release', () => {
    console.log(`${lockName} release`)
  })

  // lock.on('end', () => {
  //   console.log(`${lockName} end`)
  // })
}

// LOCK HANDLERS : genesis
registerLockEvents(genesisLock, 'genesisLock', async () => {
  // The value of the lock determines what function it triggers
  // Is a genesis block needed? If not release lock and move on.
  try {
    let c = await CalendarBlock.count()
    if (c === 0) {
      try {
        await createGenesisBlockAsync()
      } catch (error) {
        console.error('createGenesisBlock error - ' + error)
      }
    } else {
      console.log(`No genesis block needed : ${c} block(s) found.`)
    }
  } catch (error) {
    console.log(`Unable to count calendar blocks`)
  } finally {
    genesisLock.release()
  }
})

// LOCK HANDLERS : calendar
registerLockEvents(calendarLock, 'calendarLock', async () => {
  try {
    let treeDataObj = generateCalendarTree()
    if (treeDataObj) { // there is some data to process, continue and persist
      await persistCalendarTreeAsync(treeDataObj)
    } else { // there is nothing to process in this calendar interval, write nothing, release lock
      console.log('no hashes for this calendar interval')
    }
  } catch (error) {
    console.error('persistCalendarTree error - ' + error)
  } finally {
    calendarLock.release()
  }
})

// LOCK HANDLERS : nist
registerLockEvents(nistLock, 'nistLock', async () => {
  try {
    if (nistLatest) {
      console.log(nistLatest)
      await createNistBlockAsync(nistLatest)
    } else {
      console.error('nistLatest is null or missing Value property')
    }
  } catch (error) {
    console.error('createNistBlock error - ' + error)
  } finally {
    nistLock.release()
  }
})

// LOCK HANDLERS : btc-anchor
registerLockEvents(btcAnchorLock, 'btcAnchorLock', async () => {
  // checks if the last btc anchor block is at least ANCHOR_BTC_INTERVAL_MS old
  // Only if so, we write a new anchor and do the work of that function. Otherwise immediate release lock.
  try {
    let lastBtcAnchorBlock = await CalendarBlock.findOne({ where: { type: 'btc-a' }, attributes: ['id', 'hash'], order: 'id DESC' })
    if (lastBtcAnchorBlock) {
      // check if the last btc anchor block is at least ANCHOR_BTC_INTERVAL_MS old
      // if not, release lock and return
      let lastBtcAnchorMS = lastBtcAnchorBlock.time
      let currentMS = Date.now()
      let ageMS = currentMS - lastBtcAnchorMS
      if (ageMS < env.ANCHOR_BTC_INTERVAL_MS) {
        console.log('aggregateAndAnchorBTC skipped, ANCHOR_BTC_INTERVAL_MS not elapsed since last btc anchor block')
        return
      }
    }
    let lastBtcAnchorBlockId = lastBtcAnchorBlock ? parseInt(lastBtcAnchorBlock.id, 10) : null
    aggregateAndAnchorBTC(lastBtcAnchorBlockId, (err) => {
      if (err) {
        console.error('aggregateAndAnchorBTC error - ' + err)
      }
    })
  } catch (error) {
    console.error(`Unable to query calendar blocks`)
  } finally {
    btcAnchorLock.release()
  }
})

// LOCK HANDLERS : btc-confirm
registerLockEvents(btcConfirmLock, 'btcConfirmLock', () => {
  try {
    let monMessageToProcess = BTC_MON_MESSAGES.splice(0)
    // if there are no messaes left to processes, release lock and return
    if (monMessageToProcess.length === 0) return

    async.eachSeries(monMessageToProcess, (msg, eachCallback) => {
      let btcMonObj = JSON.parse(msg.content.toString())
      let btctxId = btcMonObj.btctx_id
      let btcheadHeight = btcMonObj.btchead_height
      let btcheadRoot = btcMonObj.btchead_root
      let proofPath = btcMonObj.path

      async.waterfall([
        // Store Merkle root of BTC block in chain
        async (wfCallback) => {
          try {
            let block = await createBtcConfirmBlockAsync(btcheadHeight, btcheadRoot)
            return wfCallback(null, block)
          } catch (error) {
            return wfCallback(error)
          }
        },
        // queue up message containing updated proof state bound for proof state service
        (block, wfCallback) => {
          let stateObj = {}
          stateObj.btctx_id = btctxId
          stateObj.btchead_height = btcheadHeight
          stateObj.btchead_state = {}
          stateObj.btchead_state.ops = formatAsChainpointV3Ops(proofPath, 'sha-256-x2')

          // Build the anchors uris using the locations configured in CHAINPOINT_BASE_URI
          let BASE_URIS = [env.CHAINPOINT_BASE_URI]
          let uris = []
          for (let x = 0; x < BASE_URIS.length; x++) uris.push(`${BASE_URIS[x]}/calendar/${block.id}/data`)
          stateObj.btchead_state.anchor = {
            anchor_id: btcheadHeight.toString(),
            uris: uris
          }

          amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btcmon' },
            (err, ok) => {
              if (err !== null) {
                // An error as occurred publishing a message
                console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[btcmon] publish message nacked')
                return wfCallback(err)
              } else {
                // New message has been published
                console.log(env.RMQ_WORK_OUT_STATE_QUEUE, '[btcmon] publish message acked')
                return wfCallback(null)
              }
            })
        }
      ], (err) => {
        if (err) {
          // nack consumption of all original message
          console.error(err)
          amqpChannel.nack(msg)
          console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[btcmon] consume message nacked')
        } else {
          // ack consumption of all original hash messages part of this aggregation event
          amqpChannel.ack(msg)
          console.log(env.RMQ_WORK_IN_CAL_QUEUE, '[btcmon] consume message acked')
        }
        return eachCallback(null)
      })
    },
      (err) => {
        if (err) console.error('monitoring message processing error - ' + err)
      })
  } catch (error) {
    console.error('monitoring message processing error - ' + error)
  } finally {
    btcConfirmLock.release()
  }
})

// LOCK HANDLERS : eth-anchor
registerLockEvents(ethAnchorLock, 'ethAnchorLock', async () => {
  // checks if the eth last anchor block is at least ANCHOR_ETH_INTERVAL_MS old
  // Only if so, we write a new anchor and do the work of that function. Otherwise immediate release lock.
  try {
    let lastEthAnchorBlock = await CalendarBlock.findOne({ where: { type: 'eth-a' }, attributes: ['id', 'hash'], order: 'id DESC' })
    if (lastEthAnchorBlock) {
      // check if the last eth anchor block is at least ANCHOR_ETH_INTERVAL_MS old
      // if not, release lock and return
      let lastEthAnchorMS = lastEthAnchorBlock.time
      let currentMS = Date.now()
      let ageMS = currentMS - lastEthAnchorMS
      if (ageMS < env.ANCHOR_ETH_INTERVAL_MS) {
        console.log('aggregateAndAnchorBTC skipped, ANCHOR_ETH_INTERVAL_MS not elapsed since last eth anchor block')
        return
      }
    }
    let lastEthAnchorBlockId = lastEthAnchorBlock ? parseInt(lastEthAnchorBlock.id, 10) : null
    aggregateAndAnchorETH(lastEthAnchorBlockId, (err) => {
      if (err) {
        console.error('aggregateAndAnchorETH error - ' + err)
      }
    })
  } catch (error) {
    console.log(`Unable to query calendar blocks`)
  } finally {
    ethAnchorLock.release()
  }
})

// LOCK HANDLERS : eth-confirm
registerLockEvents(ethConfirmLock, 'ethConfirmLock', () => {
  try {

  } catch (error) {

  } finally {
    ethConfirmLock.release()
  }
})

// Set the BTC anchor interval defined by ANCHOR_BTC_INTERVAL_MS
// and return a reference to that configured interval, enabling BTC anchoring
let setBtcInterval = () => {
  return setInterval(() => {
    try {
      // if the amqp channel is null (closed), processing should not continue, defer to next interval
      if (amqpChannel === null) return
      btcAnchorLock.acquire()
    } catch (err) {
      console.error('btcAnchorLock.acquire() : caught err : ', err.message)
    }
  }, env.ANCHOR_BTC_INTERVAL_MS)
}

// Set the ETH anchor interval defined by ANCHOR_ETH_INTERVAL_MS
// and return a reference to that configured interval, enabling ETH anchoring
let setEthInterval = () => {
  return setInterval(() => {
    try {
      // if the amqp channel is null (closed), processing should not continue, defer to next interval
      if (amqpChannel === null) return
      ethAnchorLock.acquire()
    } catch (err) {
      console.error('ethAnchorLock.acquire() : caught err : ', err.message)
    }
  }, env.ANCHOR_ETH_INTERVAL_MS)
}

// Deletes the BTC anchoring interval, disabling BTC anchoring
let deleteBtcInterval = () => {
  clearInterval(anchorBtcInterval)
}

// Deletes the ETH anchoring interval, disabling ETH anchoring
let deleteEthInterval = () => {
  clearInterval(anchorEthInterval)
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await sequelize.sync({ logging: false })
      console.log('Sequelize connection established')
      dbConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
  // trigger creation of the genesis block
  genesisLock.acquire()
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectionString - The connection string for the RabbitMQ instance, an AMQP URI
 */
async function openRMQConnectionAsync (connectionString) {
  let rmqConnected = false
  while (!rmqConnected) {
    try {
      // connect to rabbitmq server
      let conn = await amqp.connect(connectionString)
      // create communication channel
      let chan = await conn.createConfirmChannel()
      // the connection and channel have been established
      chan.assertQueue(env.RMQ_WORK_IN_CAL_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_STATE_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_BTCTX_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_BTCMON_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT)
      // set 'amqpChannel' so that publishers have access to the channel
      amqpChannel = chan
      chan.consume(env.RMQ_WORK_IN_CAL_QUEUE, (msg) => {
        processMessage(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        // un-acked messaged will be requeued, so clear all work in progress
        AGGREGATION_ROOTS = []
        await utils.sleep(5000)
        await openRMQConnectionAsync(connectionString)
      })
      console.log('RabbitMQ connection established')
      rmqConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish RabbitMQ connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

// This initalizes all the consul watches and JS intervals that fire all calendar events
function startWatchesAndIntervals () {
  // console.log('starting watches and intervals')

  // Continuous watch on the consul key holding the NIST object.
  var nistWatch = consul.watch({ method: consul.kv.get, options: { key: env.NIST_KEY } })

  // Store the updated fee object on change
  nistWatch.on('change', function (data, res) {
    // process only if a value has been returned and it is different than what is already stored
    if (data && data.Value && nistLatest !== data.Value) {
      nistLatest = data.Value
      try {
        nistLock.acquire()
      } catch (err) {
        console.error('nistLock.acquire() : caught err : ', err.message)
      }
    }
  })

  nistWatch.on('error', function (err) {
    console.error('nistWatch error: ', err)
  })

  // PERIODIC TIMERS

  // Write a new calendar block
  setInterval(() => {
    try {
      // if the amqp channel is null (closed), processing should not continue, defer to next interval
      if (amqpChannel === null) return
      if (AGGREGATION_ROOTS.length > 0) { // there will be data to process, acquire lock and continue
        calendarLock.acquire()
      } else { // there will not be any data to process, do nothing
        // console.log('calendar interval elapsed, no data')
      }
    } catch (err) {
      console.error('calendarLock.acquire() : caught err : ', err.message)
    }
  }, env.CALENDAR_INTERVAL_MS)

  // Add all block hashes back to the previous BTC anchor to a Merkle tree and send to BTC TX
  if (env.ANCHOR_BTC === 'enabled') { // Do this only if BTC anchoring is enabled
    anchorBtcInterval = setBtcInterval()
    console.log('BTC anchoring enabled')
  } else {
    console.log('BTC anchoring disabled')
  }

  // Add all block hashes back to the previous ETH anchor to a Merkle tree and send to ETH TX
  if (env.ANCHOR_ETH === 'enabled') { // Do this only if ETH anchoring is enabled
    anchorEthInterval = setEthInterval()
    console.log('ETH anchoring enabled')
  } else {
    console.log('ETH anchoring disabled')
  }
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init DB
    await openStorageConnectionAsync()
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // Init intervals and watches
    startWatchesAndIntervals()
    console.log('startup completed successfully')
  } catch (err) {
    console.error(`An error has occurred on startup: ${err}`)
    process.exit(1)
  }
}

// get the whole show started
start()
