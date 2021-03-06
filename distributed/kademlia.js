const dgram = require('dgram')
const crypto = require('crypto')

const id_size = 4
const bucket_size = 20
const timeout = 2000

let nodeid = null
const kbuckets = Array.from({length: id_size*8+1}, () => [])

const get_id = () => new Promise((resolve, reject) => 
  crypto.randomBytes(id_size, (err, buf) => err ? reject(err) : resolve(buf)))

const zipwith = (x, y, cb) => x.map((cur, idx) => cb(cur, y[idx]))
const xorbuf = (b1, b2) => zipwith(b1, b2, (v1, v2) => v1 ^ v2) 
const rank = (b, c) => {
  if (c == null) c = 0
  const array_shift = parseInt(c / 8)
  const byte_shift = 7 - (c % 8)
  if (b.length <= array_shift) return c
  const m = b[array_shift] & (1 << byte_shift)
  if (m) return c
  return rank(b, c+1)
}

const kbuckets_push = (emitter_id, ip, port) => {
  const xored = xorbuf(emitter_id, nodeid)
  const ranked = rank(xored)
  const items = kbuckets[ranked].length
  if (kbuckets[ranked].some(e => 0 == e.node_id.compare(emitter_id))) {
    console.log(`[known] node ${emitter_id.toString('hex')}, bucket ${ranked} (${items}/${bucket_size})`)
  } else if (items < bucket_size) {
    kbuckets[ranked].push({node_id: emitter_id, ip: ip, port: port})
    console.log(`[store] node ${emitter_id.toString('hex')}, bucket ${ranked} (${items+1}/${bucket_size})`)
  } else {
    console.log(`[full] node ${emitter_id.toString('hex')}, bucket ${ranked} full (${items}/${bucket_size})`)
  }
}

const pending_requests = {}
const handle_rpc = {
  res: (fd, msg, meta) => {
    if (!pending_requests[msg.msg_id]) {
      console.error(`No pending request for UID ${msg.msg_id}`)
      return 
    }
    clearTimeout(pending_requests[msg.msg_id].timeout);
    pending_requests[msg.msg_id].resolve([fd,msg,meta])
    delete pending_requests[msg.msg_id]
  },
  ping: (fd, msg, meta) => {
    const res = JSON.stringify({
      msg_id: msg.msg_id, 
      emitter_id: nodeid.toString('hex'),
      action: 'res'
    })
    fd.send(res, meta.port, meta.ip, err => err ? console.error(err) : null)
  },
  find_node: (fd, msg, meta) => {
    try { msg.target_node = Buffer.from(msg.target_node, 'hex')} 
    catch (e) { console.error('Unable to parse target node', e, msg); return }
    
    const r = rank(msg.target_node)
    kbuckets[r].map(b => 
      new Object({node_id: b.node_id.toString('hex'), ip: b.ip, port: b.port}))
  },
  find_value: (fd, msg, meta) => null,
  store: (fd, msg, meta) => null
}

const check_rpc_msg_format = msg => {
  if (!msg.msg_id) {
    console.error("Message has no message UUID", msg)
    return false
  }

  try {
    msg.msg_id = Buffer.from(msg.msg_id, 'hex')
  } catch(e) {
    console.error("Message UUID is not valid hexadecimal", e, msg)
    return false
  }

  if (!msg.emitter_id) {
    console.error("Message has no emitter UUID", msg)
    return false
  }

  try {
    msg.emitter_id = Buffer.from(msg.emitter_id, 'hex')
  } catch (e) {
    console.error("Message emitter ID is not valid hexadecimal", e, msg)
    return false
  }

  if (!['res','ping','find_node','find_value','store'].includes(msg.action)) {
    console.error("Message action can't be found", msg)
    return false
  }

  return true
}

const rpc = (fd, ip, port, msg) => 
  get_id().then(new_id => 
    new Promise((resolve, reject) => {
      Object.assign(msg, { msg_id: new_id.toString('hex'), emitter_id: nodeid.toString('hex')}) 
      const timer = setTimeout(() => delete pending_requests[new_id], 2000)
      pending_requests[new_id] = { timeout: timer, resolve: resolve }
      fd.send(JSON.stringify(msg), port, ip, err => err ? reject(err) : null)
    }))

const start_network = port => new Promise((resolve, reject) => {
  const udpfd = dgram.createSocket('udp4')

  udpfd.on('error', err => {
    udpfd.close()
    reject(err)
  })

  udpfd.on('message', (msg, meta) => {
    try {
      const rpc_msg = JSON.parse(msg)
      if (!check_rpc_msg_format(rpc_msg)) return
      kbuckets_push(rpc_msg.emitter_id, meta.address, meta.port)
      handle_rpc[rpc_msg.action](udpfd, rpc_msg, meta)
    } catch (e) {
      console.error('Unable to parse message', e)
    }
  })

  udpfd.on('listening', () => resolve(udpfd))
  udpfd.bind(port)
})

get_id()
  .then(buf => {
    nodeid = buf
    console.log(`node id is ${buf.toString('hex')}`)
    return start_network(process.env['KAD_PORT'])
  })
  .then(udpfd => {
    addr = udpfd.address()
    console.log(`node listening on ${addr.address}:${addr.port}`)
    return rpc(udpfd, '127.0.0.1', '8888', { action: 'find_node' })
  })
  .then(([fd, msg, meta]) => {
    console.log('Ping success', msg)
  })
  .catch(e => console.error('A critical error occured in the promise chain', e))
