/*
 * Copyright 2014, Gregg Tavares.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Gregg Tavares. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF2 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

"use strict";

var sys = require('sys');
var debug = require('debug')('relayserver');

var SocketIOServer = function(server) {
  debug("Using Socket.io");

  var sio = require('socket.io');
  var io = sio.listen(server);

  var SIOClient = function(client) {
    this.client = client;
    var eventHandlers = { };

    this.send = function(msg) {
      this.client.emit('message', msg);
    };

    this.on = function(eventName, fn) {
      if (!eventHandler[eventName]) {
        this.client.on(eventName, function() {
          var fn = eventHandlers[eventName];
          if (fn) {
            fn.apply(this, arguments);
          }
        }.bind(this));
      }
      eventHandler[eventName] = fn;
    };
  };

  this.on = function(eventName, fn) {
    if (eventName == 'connection') {
      io.sockets.on(eventName, function(client) {
        var wrapper = new SIOClient(client);
        fn(wrapper);
      });
    } else {
      io.sockets.on(eventName, fn);  // does this case exist?
    }
  };
};

var WSServer = function(server) {
  debug("Using WebSockets directly");

  var WebSocketServer = require('ws').Server;
  var wss = new WebSocketServer({server: server});

  var WSClient = function(client) {
    this.client = client;
    var eventHandlers = { };

    this.send = function(msg) {
      var str = JSON.stringify(msg);
      this.client.send(str);
    };

    this.on = function(eventName, fn) {
      if (eventName == 'disconnect') {
        eventName = 'close';
      }

      if (!eventHandlers[eventName]) {
        this.client.on(eventName, function() {
          var fn = eventHandlers[eventName];
          if (fn) {
            fn.apply(this, arguments);
          }
        }.bind(this));
      }

      if (eventName == 'message') {
        var origFn = fn;
        fn = function(data, flags) {
          origFn(JSON.parse(data));
        };
      }
      eventHandlers[eventName] = fn;
    };

    this.close = function() {
      this.client.close();
    };
  };

  this.on = function(eventName, fn) {
    if (eventName == 'connection') {
      wss.on(eventName, function(client) {
        var wrapper = new WSClient(client);
        fn(wrapper);
      });
    } else {
      wss.on(eventName, fn);  // does this case exist?
    }
  };
};

var Player = function(client, relayServer, id) {
  this.game;
  this.client = client;
  this.relayServer = relayServer;
  this.id = id;
  this.intervalId;
  this.timeout = 5; // 5 seconds
  this.timeoutCheckInterval = 2; // check every 2 seconds
  this.waitingForPing = false;

  var getTime = function() {
    return Date.now() * 0.001;
  };

  var checkTimeout = function() {
    // How much time has passed since last message
    var now = getTime();
    var elapsedTime = getTime() - this.timeOfLastMessageFromPlayer;
    if (elapsedTime >= this.timeout) {
      if (this.waitingForPing) {
        // No ping from player. Kill this
        this.game.removePlayer(this);
        this.disconnect();
      } else {
        // send ping
        this.waitingForPing = true;
        this.send({cmd: '__ping__'});
      }
    }
  }.bind(this);
  this.intervalId = setInterval(checkTimeout, this.timeoutCheckInterval * 1000);

  var addPlayerToGame = function(data) {
    var game = this.relayServer.addPlayerToGame(this, data.gameId);
    this.game = game;
  }.bind(this);

  var assignAsServerForGame = function(data) {
    // Seems like player should stop existing at this point?
    //this.client('onmessage', undefined);
    //this.client('ondisconnect', undefined);
    this.relayServer.assignAsClientForGame(data, this.client);
  }.bind(this);

  var passMessageFromPlayerToGame = function(data) {
    this.timeOfLastMessageFromPlayer = getTime();
    this.game.send(this, {
      cmd: 'update',
      id: this.id,
      data: data,
    });
  }.bind(this);

  var pingAcknowledged = function(data) {
    this.timeOfLastMessageFromPlayer = getTime();
    this.waitingForPing = false;
  }.bind(this);

  var messageHandlers = {
    'join':   addPlayerToGame,
    'server': assignAsServerForGame,
    'update': passMessageFromPlayerToGame,
    'pong':   pingAcknowledged,
  };

  var onMessage = function(message) {
    var cmd = message.cmd;
    var handler = messageHandlers[cmd];
    if (!handler) {
      console.error("unknown player message: " + cmd);
      return;
    }

    handler(message.data);
  }.bind(this);

  var onDisconnect = function() {
    if (this.game) {
      this.game.removePlayer(this);
    }
    this.disconnect();
  }.bind(this);

  client.on('message', onMessage);
  client.on('disconnect', onDisconnect);
};

Player.prototype.send = function(msg) {
  try {
    this.client.send(msg);
  } catch (e) {
    console.error("error sending to client: " + e);
    console.error("disconnecting");
    this.disconnect();
  }
};

Player.prototype.sendToGame = function(msg) {
  if (this.game) {
    this.game.send(this, msg);
  }
};

Player.prototype.disconnect = function() {
  clearInterval(this.intervalId);
  this.client.on('message', undefined);
  this.client.on('disconnect', undefined);
  this.client.close();

};

var Game = function(gameId, relayServer) {
  this.gameId = gameId;
  this.relayServer = relayServer;
  this.players = {};
  this.numPlayers = 0;
  this.sendQueue = [];
};

Game.prototype.getNumPlayers = function() {
  return this.numPlayers;
};

Game.prototype.hasClient = function() {
  return this.client !== undefined;
};

Game.prototype.addPlayer = function(player) {
  var id = player.id;
  if (this.players[id]) {
    console.error("player " + id + " is already member of game " + this.gameId);
    return;
  }
  ++this.numPlayers;
  this.players[id] = player;
  this.send(null, {cmd: 'start', id: id});
};

Game.prototype.removePlayer = function(player) {
  var id = player.id;
  if (!this.players[id]) {
    console.error("player " + id + " is not a member of game " + this.gameId);
    return;
  }
  // remove queued messages from this player
  this.sendQueue = this.sendQueue.filter(function(msg) {
    return msg.owner !== player;
  });
  --this.numPlayers;
  delete this.players[player.id];
  this.send(null, {
    cmd: 'remove',
    id: id,
  });
};

Game.prototype.send = function(owner, msg) {
  if (this.client) {
    this.client.send(msg);
  } else {
    this.sendQueue.push({owner: owner, msg: msg});
  }
};

Game.prototype.forEachPlayer = function(fn) {
  for (var id in this.players) {
    var player = this.players[id];
    fn(player);
  };
};

// data:
//   gameId: id of game (not used here
//   controllerUrl: url of controller.
Game.prototype.assignClient = function(client, relayserver, data) {
  if (this.client) {
    console.error("this game already has a client!");
  }
  this.client = client;
  this.controllerUrl = data.controllerUrl;

  var sendMessageToPlayer = function(id, message) {
    var player = this.players[id];
    if (!player) {
      console.error("no player " + id + " for game " + this.gameId);
      return;
    }
    player.send(message);
  }.bind(this);

  var broadcast = function(message) {
    this.forEachPlayer(function(player) {
      player.send(message);
    });
  }.bind(this);

  var messageHandlers = {
    'client': sendMessageToPlayer,
    'broadcast': broadcast,
  };

  var onMessage = function(message) {
    var cmd = message.cmd;
    var id = message.id;
    var handler = messageHandlers[cmd];
    if (!handler) {
      console.error("unknown game message: " + cmd);
      return;
    }

    handler(id, message.data);
  }.bind(this);

  var onDisconnect = function() {
    this.client = undefined;
    this.relayServer.removeGame(this.gameId);
    this.forEachPlayer(function(player) {
      this.removePlayer(player);
      player.disconnect();
    }.bind(this));
  }.bind(this);

  client.on('message', onMessage);
  client.on('disconnect', onDisconnect);

  // start each player
  this.forEachPlayer(function(player) {
    this.client.send({
      cmd: 'start',
      id: player.id,
    });
  }.bind(this));

  // Not sure why I even have a sendQueue
  // as the game should be running before anyone
  // joins but it seems to be useful for debugging
  // since contollers start and often immediately
  // send a name and color cmd.
  this.sendQueue.forEach(function(msg) {
    this.client.send(msg.msg);
  }.bind(this));
  this.sendQueue = [];
};

// options:
//   address: used to replace "localhost" in urls.
var RelayServer = function(servers, options) {

  var g_nextSessionId = 1;
  var g_games = {};
  var g_numGames = 0;

  // --- messages to relay server ---
  //
  // join  :
  //   desc: joins a particle game
  //   args:
  //      gameId: name of game
  //
  // server:
  //   desc: identifies this session as a server
  //   args: none
  //
  // client:
  //   desc: sends a message to a specific client
  //   args:
  //      id:   session id of client
  //      data: object
  //
  // update:
  //   desc: sends an update to the game server
  //   args:
  //      anything

  // -- messages to the game server --
  //
  // update:
  //   desc: updates a player
  //   args:
  //      id: id of player to update
  //      data: data
  //
  // remove:
  //   desc: removes a player
  //   args:
  //      id: id of player to remove.
  //

  var getGame = function(gameId) {
    if (!gameId) {
      console.error("no game id!")
      return;
    }
    var game = g_games[gameId];
    if (!game) {
      game = new Game(gameId, this);
      g_games[gameId] = game;
      ++g_numGames;
      debug("added game: " + gameId + ", num games = " + g_numGames);
    }
    return game;
  }.bind(this);

  this.getGames = function() {
    var gameList = [];
    for (var id in g_games) {
      var game = g_games[id];
      if (game.hasClient()) {
        gameList.push({
          gameId: id,
          numPlayers: game.getNumPlayers(),
          controllerUrl: game.controllerUrl,
          foo: "bar",
        });
      }
    }
    return gameList;
  };

  this.addPlayerToGame = function(player, gameId) {
    var game = getGame(gameId);
    game.addPlayer(player);
    return game;
  }.bind(this);

  this.removeGame = function(gameId) {
    if (!g_games[gameId]) {
      console.error("no game '" + gameId + "' to remove")
      return;
    }
    --g_numGames;
    debug("removed game: " + gameId + ", num games = " + g_numGames);
    delete g_games[gameId];
  }.bind(this);

  this.assignAsClientForGame = function(data, client) {
    var game = getGame(data.gameId);
    if (data.controllerUrl && options.address) {
      data.controllerUrl = data.controllerUrl.replace("localhost", options.address);
    }
    game.assignClient(client, this, data)
  }.bind(this);

  //var io = new SocketIOServer(server);
  for (var ii = 0; ii < servers.length; ++ii) {
    var server = servers[ii];
    var io = new WSServer(server);

    io.on('connection', function(client){
        new Player(client, this, ++g_nextSessionId);
    }.bind(this));
  }

};

exports.RelayServer = RelayServer;
