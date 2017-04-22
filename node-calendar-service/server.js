const async = require('async')
const _ = require('lodash')
const MerkleTools = require('merkle-tools')
const amqp = require('amqplib')
const uuidv1 = require('uuid/v1')

require('dotenv').config()

// The frequency to generate new calendar trees
const CALENDAR_INTERVAL = process.env.CALENDAR_INTERVAL || 1000

// How often should calendar trees be finalized
const FINALIZATION_INTERVAL = process.env.FINALIZE_INTERVAL || 250

// The name of the RabbitMQ topic exchange to use
const RMQ_WORK_EXCHANGE_NAME = process.env.RMQ_WORK_EXCHANGE_NAME || 'work_topic_exchange'

// The topic exchange routing key for message consumption originating from the aggregation service
const RMQ_WORK_IN_ROUTING_KEY = process.env.RMQ_WORK_IN_ROUTING_KEY || 'work.cal'

// The topic exchange routing key for message publishing bound for the proof state service
const RMQ_WORK_OUT_STATE_ROUTING_KEY = process.env.RMQ_WORK_OUT_STATE_ROUTING_KEY || 'work.cal.state'

// Connection string w/ credentials for RabbitMQ
const RABBITMQ_CONNECT_URI = process.env.RABBITMQ_CONNECT_URI || 'amqp://chainpoint:chainpoint@rabbitmq'

// TODO: Validate env variables and exit if values are out of bounds

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// An array of all Merkle tree roots from aggregators needing
// to be processed. Will be filled as new roots arrive on the queue.
let AGGREGATION_ROOTS = []

// An array of all tree data ready to be finalized.
// Will be filled by the generateCalendar process as the
// merkle trees are built. Each object in this array
// contains the merkle root and the agg_id and proof
// paths for each leaf of the tree.
let TREES = []

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// TODO move this elsewhere
function formatAsChpOps (proof, op) {
  let chpProof = proof.map(function (item) {
    if (item.left) {
      return { l: item.left }
    } else {
      return { r: item.right }
    }
  })
  let chpProofWithOps = []
  for (let x = 0; x < chpProof.length; x++) {
    chpProofWithOps.push(chpProof[x])
    chpProofWithOps.push({ op: op })
  }
  return chpProofWithOps
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectionString - The connection string for the RabbitMQ instance, an AMQP URI
 */
function amqpOpenConnection (connectionString) {
  amqp.connect(connectionString).then(function (conn) {
    conn.on('close', () => {
      // if the channel closes for any reason, attempt to reconnect
      console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
      // channel is lost, reset to null
      amqpChannel = null
      setTimeout(amqpOpenConnection.bind(null, connectionString), 5 * 1000)
    })
    conn.createConfirmChannel().then(function (chan) {
      // the connection and channel have been established
      // set 'amqpChannel' so that publishers have access to the channel
      console.log('Connection established')
      chan.assertExchange(RMQ_WORK_EXCHANGE_NAME, 'topic', { durable: true })
      amqpChannel = chan

      // Continuously load the AGGREGATION_ROOTS from RMQ with root objects to process
      return chan.assertQueue('', { durable: true }).then(function (q) {
        chan.bindQueue(q.queue, RMQ_WORK_EXCHANGE_NAME, RMQ_WORK_IN_ROUTING_KEY)
        return chan.consume(q.queue, function (msg) {
          consumeAggRootMessage(msg)
        })
      })
    })
  }).catch(() => {
    // catch errors when attempting to establish connection
    console.error('Cannot establish connection. Attempting in 5 seconds...')
    setTimeout(amqpOpenConnection.bind(null, connectionString), 5 * 1000)
  })
}

function consumeAggRootMessage (msg) {
  if (msg !== null) {
    let rootObj = JSON.parse(msg.content.toString())
    console.log(rootObj)

    // add msg to the root object so that we can ack it during the finalize process for this root object
    rootObj.msg = msg
    AGGREGATION_ROOTS.push(rootObj)
  }
}

// AMQP initialization
amqpOpenConnection(RABBITMQ_CONNECT_URI)

// Take work off of the AGGREGATION_ROOTS array and build Merkle tree
let generateCalendar = function () {
  let rootsForTree = AGGREGATION_ROOTS.splice(0)

  // create merkle tree only if there is at least one root to process
  if (rootsForTree.length > 0) {
    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // get root values from root objects
    let leaves = rootsForTree.map(rootObj => {
      return rootObj.agg_root
    })

    // Add every root in rootsForTree to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    // Collect and store the calendar id, Merkle root, and proofs in an array where finalize() can find it
    let treeData = {}
    treeData.cal_id = uuidv1()
    treeData.cal_root = merkleTools.getMerkleRoot().toString('hex')

    let treeSize = merkleTools.getLeafCount()
    let proofData = []
    for (let x = 0; x < treeSize; x++) {
      // push the agg_id and corresponding proof onto the array
      let proofDataItem = {}
      proofDataItem.agg_id = rootsForTree[x].agg_id
      proofDataItem.agg_root = rootsForTree[x].agg_root
      proofDataItem.agg_msg = rootsForTree[x].msg
      let proof = merkleTools.getProof(x)
      proofDataItem.proof = formatAsChpOps(proof)
      proofData.push(proofDataItem)
    }
    treeData.proofData = proofData

    TREES.push(treeData)
    console.log('rootsForTree length : %s', rootsForTree.length)
  }
}

// Temp/incomplete finalize function for writing to proof state service only, no calendar functions yet
let finalize = function () {
  // if the amqp channel is null (closed), processing should not continue, defer to next finalize call
  if (amqpChannel === null) return

  // process each set of tree data
  let treesToFinalize = TREES.splice(0)
  _.forEach(treesToFinalize, function (treeDataObj) {
    console.log('Processing tree', treesToFinalize.indexOf(treeDataObj) + 1, 'of', treesToFinalize.length)

    // queue state messages, and when complete, queue message for calendar service to continue processing
    async.series([

      function (callback) {
        // TODO store Merkle root of calendar in DB and chain to previous calendar entries
        console.log('calendar write')
        // TODO this should all work without the line below, CrateDB eventual consistency to blame?
        setTimeout(callback, 1100)
      },
      function (callback) {
        // for each aggregation root, queue up message containing updated proof state bound for proof state service
        async.each(treeDataObj.proofData, function (proofDataItem, eachCallback) {
          let stateObj = {}
          stateObj.agg_id = proofDataItem.agg_id
          stateObj.agg_root = proofDataItem.agg_root
          stateObj.cal_id = treeDataObj.cal_id
          stateObj.cal_root = treeDataObj.cal_root
          stateObj.cal_state = {}
          stateObj.cal_state.ops = proofDataItem.proof
          // temp anchor data until real values are generated
          stateObj.cal_state.anchor = {
            anchor_id: '1027',
            uris: [
              'http://a.cal.chainpoint.org/1027/root',
              'http://b.cal.chainpoint.org/1027/root'
            ]
          }

          amqpChannel.publish(RMQ_WORK_EXCHANGE_NAME, RMQ_WORK_OUT_STATE_ROUTING_KEY, new Buffer(JSON.stringify(stateObj)), { persistent: true },
            function (err, ok) {
              if (err !== null) {
                // An error as occurred publishing a message
                console.error(RMQ_WORK_OUT_STATE_ROUTING_KEY, 'publish message nacked')
                return eachCallback(err)
              } else {
                // New message has been published
                console.log(RMQ_WORK_OUT_STATE_ROUTING_KEY, 'publish message acked')
                return eachCallback(null)
              }
            })
        }, function (err) {
          if (err) {
            console.error('Processing of tree', treesToFinalize.indexOf(treeDataObj) + 1, 'had errors.')
            return callback(err)
          } else {
            console.log('Processing of tree', treesToFinalize.indexOf(treeDataObj) + 1, 'complete')
            // pass all the agg_msg objects to the series() callback
            let messages = treeDataObj.proofData.map(proofDataItem => {
              return proofDataItem.agg_msg
            })
            return callback(null, messages)
          }
        })
      },
      function (callback) {
        let calObj = {}
        calObj.cal_id = treeDataObj.cal_id
        calObj.cal_root = treeDataObj.cal_root
        /*
        amqpChannel.publish(RMQ_WORK_EXCHANGE_NAME, RMQ_WORK_OUT_CAL_ROUTING_KEY, new Buffer(JSON.stringify(aggObj)), { persistent: true },
          function (err, ok) {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(RMQ_WORK_OUT_CAL_ROUTING_KEY, 'publish message nacked')
              return callback(err)
            } else {
              // New message has been published
              console.log(RMQ_WORK_OUT_CAL_ROUTING_KEY, 'publish message acked')
              return callback(null)
            }
          }) */
        return callback(null)
      }
    ], function (err, results) {
      // results[0] contains an array of agg_msg objects from the first function in this series
      if (err) {
        _.forEach(results[0], function (message) {
          // nack consumption of all original hash messages part of this aggregation event
          if (message !== null) {
            amqpChannel.nack(message)
            console.error(RMQ_WORK_IN_ROUTING_KEY, 'consume message nacked')
          }
        })
      } else {
        _.forEach(results[0], function (message) {
          if (message !== null) {
            // ack consumption of all original hash messages part of this aggregation event
            amqpChannel.ack(message)
            console.error(RMQ_WORK_IN_ROUTING_KEY, 'consume message acked')
          }
        })
      }
    })
  })
}

setInterval(() => generateCalendar(), CALENDAR_INTERVAL)

setInterval(() => finalize(), FINALIZATION_INTERVAL)
