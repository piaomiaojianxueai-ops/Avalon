(function (global) {
  "use strict";

  const ROOM_PREFIX = "axiospan-avalon-v2-";
  const PROTOCOL_VERSION = 2;

  class DomainRoomTransport {
    constructor() {
      this.peer = null;
      this.connections = new Map();
      this.handlers = new Map();
      this.statusHandlers = new Set();
      this.connectHandlers = new Set();
      this.disconnectHandlers = new Set();
      this.isHost = false;
      this.roomCode = "";
      this.playerId = this.loadPlayerId();
      this.playerName = "";
      this.status = "offline";
    }

    loadPlayerId() {
      const key = "avalon-player-id";
      let id = sessionStorage.getItem(key);
      if (!id) {
        id = `player_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(key, id);
      }
      return id;
    }

    setIdentity(name) {
      this.playerName = String(name || "").trim().slice(0, 16);
    }

    onMessage(type, handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type).add(handler);
      return () => this.handlers.get(type)?.delete(handler);
    }

    onStatus(handler) {
      this.statusHandlers.add(handler);
      return () => this.statusHandlers.delete(handler);
    }

    onConnect(handler) {
      this.connectHandlers.add(handler);
      return () => this.connectHandlers.delete(handler);
    }

    onDisconnect(handler) {
      this.disconnectHandlers.add(handler);
      return () => this.disconnectHandlers.delete(handler);
    }

    emitStatus(status, detail = "") {
      this.status = status;
      this.statusHandlers.forEach((handler) => handler({ status, detail }));
    }

    dispatch(message, context = {}) {
      if (!message || typeof message !== "object" || !message.type) return;
      const handlers = this.handlers.get(message.type);
      if (!handlers) return;
      handlers.forEach((handler) => {
        try {
          handler(message, context);
        } catch (error) {
          console.error(`Avalon handler failed for ${message.type}`, error);
        }
      });
    }

    parseMessage(raw) {
      if (typeof raw === "string") return JSON.parse(raw);
      if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw));
      if (ArrayBuffer.isView(raw)) return JSON.parse(new TextDecoder().decode(raw));
      return raw;
    }

    handleIncoming(raw, connection) {
      try {
        const message = this.parseMessage(raw);
        this.dispatch(message, {
          remotePlayerId: connection.metadata?.playerId || connection.peer,
          connection
        });
      } catch (error) {
        console.error("Unable to parse Avalon network message", error);
      }
    }

    async hostRoom(code, name) {
      this.cleanup();
      this.setIdentity(name);
      this.isHost = true;
      this.roomCode = this.normalizeCode(code);
      this.emitStatus("connecting", "正在建立房間");

      return new Promise((resolve, reject) => {
        this.peer = new Peer(ROOM_PREFIX + this.roomCode);

        this.peer.on("open", () => {
          this.emitStatus("online", `房間 ${this.roomCode} 已建立`);
          resolve(this.roomCode);
        });

        this.peer.on("connection", (connection) => {
          const metadata = connection.metadata || {};
          if (metadata.protocolVersion !== PROTOCOL_VERSION || !metadata.playerId) {
            connection.close();
            return;
          }
          this.wireConnection(connection, metadata.playerId, metadata.playerName);
        });

        this.peer.on("error", (error) => {
          const message = error.type === "unavailable-id"
            ? "房號剛好被使用，請重新建立"
            : `建立房間失敗：${this.describePeerError(error.type)}`;
          this.emitStatus("error", message);
          reject(new Error(message));
        });

        this.peer.on("disconnected", () => {
          this.emitStatus("connecting", "訊號服務暫時中斷，正在重連");
          try {
            this.peer.reconnect();
          } catch (_) {}
        });
      });
    }

    async joinRoom(code, name) {
      this.cleanup();
      this.setIdentity(name);
      this.isHost = false;
      this.roomCode = this.normalizeCode(code);
      this.emitStatus("connecting", `正在加入 ${this.roomCode}`);

      return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          const message = "找不到房間，請確認房號或請房主重新建立";
          this.emitStatus("error", message);
          this.cleanup();
          reject(new Error(message));
        }, 10000);

        this.peer = new Peer();
        this.peer.on("open", () => {
          const connection = this.peer.connect(ROOM_PREFIX + this.roomCode, {
            reliable: true,
            metadata: {
              protocolVersion: PROTOCOL_VERSION,
              playerId: this.playerId,
              playerName: this.playerName
            }
          });
          this.wireConnection(connection, "host", "房主", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.emitStatus("online", `已加入房間 ${this.roomCode}`);
            resolve(this.roomCode);
          });
        });

        this.peer.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const message = `加入失敗：${this.describePeerError(error.type)}`;
          this.emitStatus("error", message);
          reject(new Error(message));
        });

        this.peer.on("disconnected", () => {
          this.emitStatus("connecting", "訊號服務暫時中斷，現有對戰仍可繼續");
        });
      });
    }

    wireConnection(connection, remotePlayerId, remotePlayerName, onOpen) {
      const info = {
        connection,
        playerId: remotePlayerId,
        playerName: remotePlayerName || `玩家${String(remotePlayerId).slice(-4)}`,
        open: false
      };
      this.connections.set(remotePlayerId, info);

      connection.on("open", () => {
        info.open = true;
        this.connectHandlers.forEach((handler) => handler({
          playerId: remotePlayerId,
          playerName: info.playerName
        }));

        if (this.isHost) {
          this.dispatch({
            type: "player_joined",
            playerId: remotePlayerId,
            playerName: info.playerName
          }, { connection, remotePlayerId });
        }

        if (onOpen) onOpen();
      });

      connection.on("data", (data) => this.handleIncoming(data, connection));

      connection.on("close", () => {
        info.open = false;
        this.connections.delete(remotePlayerId);
        this.disconnectHandlers.forEach((handler) => handler({
          playerId: remotePlayerId,
          playerName: info.playerName
        }));
      });

      connection.on("error", (error) => {
        console.error("Avalon data connection error", error);
      });
    }

    normalizeCode(code) {
      return String(code || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
    }

    serialize(message) {
      return JSON.stringify({
        ...message,
        sentAt: Date.now()
      });
    }

    send(message) {
      if (this.isHost) {
        this.broadcast(message);
        return;
      }
      const host = this.connections.get("host");
      if (host?.open) host.connection.send(this.serialize(message));
    }

    broadcast(message, options = {}) {
      if (!this.isHost) {
        this.send(message);
        return;
      }
      const payload = this.serialize(message);
      this.connections.forEach((info, playerId) => {
        if (info.open && playerId !== options.excludePlayerId) {
          info.connection.send(payload);
        }
      });
    }

    sendToPlayer(playerId, message) {
      if (playerId === this.playerId) {
        queueMicrotask(() => this.dispatch(message, { local: true }));
        return true;
      }

      if (!this.isHost) {
        this.send({ ...message, targetPlayerId: playerId });
        return false;
      }

      const info = this.connections.get(playerId);
      if (!info?.open) return false;
      info.connection.send(this.serialize(message));
      return true;
    }

    getConnectedPlayerCount() {
      return Array.from(this.connections.values()).filter((info) => info.open).length;
    }

    getPlayerIds() {
      return Array.from(this.connections.keys());
    }

    isHostPlayer() {
      return this.isHost;
    }

    getCurrentPlayerId() {
      return this.playerId;
    }

    getRoomCode() {
      return this.roomCode;
    }

    describePeerError(type) {
      const errors = {
        "peer-unavailable": "房間不存在或房主已離線",
        "network": "網路或訊號服務無法連線",
        "server-error": "訊號服務暫時異常",
        "socket-error": "無法連接訊號服務",
        "socket-closed": "訊號連線已關閉",
        "browser-incompatible": "此瀏覽器不支援 WebRTC",
        "webrtc": "裝置間的 P2P 連線失敗"
      };
      return errors[type] || type || "未知錯誤";
    }

    cleanup() {
      this.connections.forEach((info) => {
        try {
          info.connection.close();
        } catch (_) {}
      });
      this.connections.clear();

      if (this.peer) {
        try {
          this.peer.destroy();
        } catch (_) {}
      }

      this.peer = null;
      this.isHost = false;
      this.roomCode = "";
      this.emitStatus("offline", "尚未連線");
    }
  }

  global.DomainRoomTransport = DomainRoomTransport;
})(window);
