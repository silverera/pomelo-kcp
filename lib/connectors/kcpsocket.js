/**
 * Copyright 2016 leenjewel
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var kcp = require('node-kcp');
var pomelocoder = require('./pomelocoder');
var protocol = require('pomelo-protocol');
var Package = protocol.Package;
var logger = require('pomelo-logger').getLogger('pomelo',"kcp");

var ST_INITED = 0;
var ST_WAIT_ACK = 1;
var ST_WORKING = 2;
var ST_CLOSED = 3;

var output = function(data, size, thiz) {
    if (thiz.opts.useUDP) {
        thiz.socket.send(data, 0, size, thiz.port, thiz.host);
    } else {
        thiz.socket.write(data);
    }
};

var Socket = function(id, socket, address, port, opts) {
    EventEmitter.call(this);
    var self = this;
    this.disconnected = false;
    this.id = id;
    this.socket = socket;
	this.host = address;
	this.port = port;
	this.remoteAddress = {
        ip: this.host,
        port: this.port
    };
    this.opts = opts;
    var conv = opts.conv || 123;
    this.kcpobj = new kcp.KCP(conv, self);
    if (!!opts) {
        var nodelay = opts.nodelay || 0;
        var interval = opts.interval || 10;
        var resend = opts.resend || 2;
        var nc = opts.nc || 1;
        this.kcpobj.nodelay(nodelay, interval, resend, nc);

        var sndwnd = opts.sndwnd || 256;
        var rcvwnd = opts.rcvwnd || sndwnd;
        this.kcpobj.wndsize(sndwnd, rcvwnd);

        var mtu = opts.mtu || 1400;
        this.kcpobj.setmtu(mtu);
    }
    this.kcpobj.output(output);
    this.on('input', function (msg) {
        if (!this.kcpobj) {
            return;
        }
        this.kcpobj.input(msg);
        var data = this.kcpobj.recv();
        if (!!data) {
            if (self.opts && self.opts.usePomeloPackage) {
                pomelocoder.handlePackage(self, data);
            } else {
                self.emit('message', data);
            }
        }
    });
    this.on('end', function(msg){
        if (!!msg) {
            self.socket.write(msg);
            self.state = ST_CLOSED;
            self.emit('end');
        }
    });
    // this.check();
    if (!!opts && opts.usePomeloPackage) {
        this.state = ST_INITED;
    } else {
        this.state = ST_WORKING;
    }

    logger.info("kcp connect ip:%s port:%s playerID: %s",this.port,this.host,conv);
};

util.inherits(Socket, EventEmitter);

module.exports = Socket;

Socket.prototype.check = function () {
    if (!this.kcpobj || this.state == ST_CLOSED) {
        return;
    }
    const now = Date.now();
    this.kcpobj.update(now);
    this.kcpobj.check(now);
    // logger.info("nexms %s", nexms);
    // setTimeout(() => {
    //     this.check();
    // }, this.kcpobj.check(now));
};

Socket.prototype.send = function(msg) {
    if (this.state != ST_WORKING) {
        return;
    }
    if (msg instanceof String) {
        msg = new Buffer(msg);
    } else if (!(msg instanceof Buffer)) {
        msg = new Buffer(JSON.stringify(msg));
    }
    this.sendRaw(this.opts.usePomeloPackage ? Package.encode(Package.TYPE_DATA, msg) : msg);
};

Socket.prototype.sendRaw = function(msg) {
    if (!this.kcpobj || this.state == ST_CLOSED) {
        return;
    }
    this.kcpobj.send(msg);
    this.kcpobj.flush();
}

Socket.prototype.sendForce = function(msg) {
    if (this.state == ST_CLOSED) {
        return;
    }
    this.sendRaw(msg);
};

Socket.prototype.sendBatch = function(msgs) {
    if (this.state != ST_WORKING) {
        return;
    }
    var rs = [];
    for (var i = 0; i < msgs.length; i++) {
	rs.push(this.opts.usePomeloPackage ? Package.encode(Package.TYPE_DATA, msgs[i]) : msgs[i]);
    }
    this.sendRaw(Buffer.concat(rs));
};

Socket.prototype.handshakeResponse = function(resp) {
  if(this.state !== ST_INITED) {
    return;
  }
  this.sendRaw(resp);
  this.state = ST_WAIT_ACK;
};

Socket.prototype.disconnect = function(msg) {
    if (this.state == ST_CLOSED) {
        return;
    }
    this.disconnected = true;
    this.state = ST_CLOSED;
    this.kcpobj.release();
    this.emit('disconnect', 'kcp connection disconnected');
    this.kcpobj = null;

    logger.info("kcp disconnect ip:%s port:%s playerID: %s",this.port,this.host,this.opts.conv);
};

