var fs = require('fs')
var test = require('tape')
var spawn = require('child_process').spawn
var exec = require('child_process').exec
var crypto = require('crypto')
var net = require('net')
var mkdirp = require('mkdirp')
var join = require('path').join
var ma = require('multiserver-address')

// travis currently does not support ipv6, becaue GCE does not.
var has_ipv6 = process.env.TRAVIS === undefined
var children = []

process.on('exit', function () {
  children.forEach(function (e) {
    e.kill(9)
  })
})
process.on('SIGINT', function () {
  children.forEach(function (e) {
    e.kill(9)
  })
  process.exit(1)
})


function sbot(t, argv, opts) {
  opts = opts || {}

  var sh = spawn(
    process.execPath,
    [join(__dirname, '../bin.js')]
    .concat(argv),
    Object.assign({
      env: Object.assign({}, process.env, {ssb_appname: 'test'}),
    }, opts)
  )

  sh.once('exit', function (code, name) {
    t.equal(name,'SIGKILL')
    t.end()
  })

  sh.stdout.pipe(process.stdout)
  sh.stderr.pipe(process.stderr)

  children.push(sh)

  return function end () {
    while(children.length) children.shift().kill(9)
  }
}

function try_often(times, opts, work, done) {
  if (typeof opts == 'function') {
    done = work
    work = opts
    opts = {}
  }
  const delay = 2000
  setTimeout(function() { // delay first try
    console.log('try more:', times)
    work(function(err, result) {
      if (!err) return done(null, result)
      if (opts.ignore && err.message && !err.message.match(opts.ignore)) {
        console.error('Fatal error:', err)
        return done(err)
      }
      if (!times) return done(err)
      console.warn('retry run', times)
      console.error('work(err):', err)
      try_often(times-1, work, done)
    })
  }, delay)
}

function connect(port, host, cb) {
  var done = false
  var socket = net.connect(port, host)
  socket.on('error', function(err) {
    if (done) return
    done = true
    cb(err)
  })
  socket.on('connect', function() {
    if (done) return
    done = true
    cb(null)
  })
}

function testSbot(t, opts, asConfig, port, cb) {
  var dir = '/tmp/sbot_binjstest_' + Date.now()
  if('function' === typeof port)
    cb = port, port = opts.port
  mkdirp.sync(dir)
  var args = [
    'server',
    '--path '+dir
  ]

  if(asConfig) {
    fs.writeFileSync(join(dir, '.testrc'), JSON.stringify(opts))
  } else {
    ;(function toArgs (prefix, opts) {
      for(var k in opts) {
        if(opts[k] && 'object' == typeof opts[k])
          toArgs(prefix+k+'.', opts[k])
        else
          args.push(prefix+k+'='+opts[k])
      }
    })('--', opts)
  }

  var end = sbot(t, args, {
    cwd: dir
  })

  try_often(10, {
    ignore: /ECONNREFUSED/
  }, function work(cb) {
    connect(port, opts.host, cb)
  }, function (err) {
    cb(err)
    end()
  })
}

;['::1', '::', '127.0.0.1', 'localhost'].forEach(function (host) {
  if(!has_ipv6 && /:/.test(host)) return

  ;[9002, 9001].forEach(function (port) {
    ;[true, false].forEach(function (asConfig) {
      var opts = {
        host: host,
        port: 9001,
        ws: { port: 9002 }
      }

      test('run bin.js server with ' + 
        (asConfig ? 'a config file' : 'command line options') +
        ':'+JSON.stringify(opts)+' then connect to port:'+port
      , function(t) {
        testSbot(t, opts, true, function (err) {
          t.error(err, 'Successfully connect eventually')
        })
      })
    })
  })
})

test('sbot should have websockets and http server by default', function(t) {
  var path = '/tmp/sbot_binjstest_' + Date.now()
  var caps = crypto.randomBytes(32).toString('base64')
  var end = sbot(t, [
    'server',
    '--host=127.0.0.1',
    '--port=9001',
    '--ws.port=9002',
    '--path', path,
    '--caps.shs', caps
  ])

  try_often(10, function work(cb) {
    exec([
      join(__dirname, '../bin.js'),
      'getAddress',
      'device',
      '--',
      '--host=127.0.0.1',
      '--port=9001',
      '--path', path,
      '--caps.shs', caps
    ].join(' '), {
      env: Object.assign({}, process.env, {ssb_appname: 'test'})
    }, function(err, stdout, sderr) {
      if (err) return cb(err)
      cb(null, JSON.parse(stdout))  // remove quotes
    })
  }, function(err, addr) {
    t.error(err, 'sbot getAdress succeeds eventually')
    if (err) return end()

    t.comment('result of sbot getAddress: ' + addr)

    var remotes = ma.decode(addr)
    console.log('remotes', remotes, addr)
    ws_remotes = remotes.filter(function(a) {
      return a.find(function(component) {
        return component.name == 'ws'
      })
    })
    t.equal(ws_remotes.length, 1, 'has one ws remote')
    var remote = ma.encode([ws_remotes[0]])
    // this breaks if multiserver address encoding changes
    t.ok(remote.indexOf('9002') > 0, 'ws address contains expected port')

    // this is a bit annoying. we can't signal ssb-client to load the secret from .path
    // it either has to be the first argument, already loaded
    var key = require('ssb-keys').loadOrCreateSync(join(path, 'secret'))
    require('ssb-client')(key, {
      path: path,
      caps: { shs: caps }, // has to be set when setting any config
      remote: remote
    }, function(err, ssb) {
      t.error(err, 'ssb-client returns no error')
      t.ok(ssb.manifest, 'got manifest from api')
      t.ok(ssb.version, 'got version from api')
      ssb.whoami(function(err, feed) {
        t.error(err, 'ssb.whoami succeeds')
        t.equal(feed.id[0], '@', 'feed.id has @ sigil')
        end()
      })
    })
  })
})
