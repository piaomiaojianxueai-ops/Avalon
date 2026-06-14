(function (global) {
  "use strict";

  const PHASES = Object.freeze({
    WAITING: "WAITING",
    TEAM_SELECTION: "TEAM_SELECTION",
    MISSION_VOTE: "MISSION_VOTE",
    ASSASSINATION: "ASSASSINATION",
    GAME_END: "GAME_END"
  });

  const ROLE_CONFIG = {
    5: ["Merlin", "Percival", "Loyal Servant", "Morgana", "Assassin"],
    6: ["Merlin", "Percival", "Loyal Servant", "Loyal Servant", "Morgana", "Assassin"],
    7: ["Merlin", "Percival", "Loyal Servant", "Loyal Servant", "Morgana", "Oberon", "Assassin"],
    8: ["Merlin", "Percival", "Loyal Servant", "Loyal Servant", "Loyal Servant", "Morgana", "Mordred", "Assassin"],
    9: ["Merlin", "Percival", "Loyal Servant", "Loyal Servant", "Loyal Servant", "Loyal Servant", "Morgana", "Mordred", "Assassin"],
    10: ["Merlin", "Percival", "Loyal Servant", "Loyal Servant", "Loyal Servant", "Loyal Servant", "Morgana", "Mordred", "Oberon", "Assassin"]
  };

  const MISSION_SIZES = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5]
  };

  const GOOD_ROLES = new Set(["Merlin", "Percival", "Loyal Servant"]);

  class AvalonGame {
    constructor(transport) {
      this.transport = transport;
      this.listeners = new Map();
      this.roles = [];
      this.myRole = null;
      this.state = this.createInitialState();
      this.registerTransportHandlers();
    }

    createInitialState() {
      return {
        phase: PHASES.WAITING,
        players: [],
        currentMission: 0,
        currentLeaderId: null,
        selectedMembers: [],
        submittedVoteIds: [],
        missionResults: [],
        revealedRoles: [],
        winner: null,
        message: "等待玩家加入"
      };
    }

    on(event, handler) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(handler);
      return () => this.listeners.get(event)?.delete(handler);
    }

    emit(event, payload) {
      this.listeners.get(event)?.forEach((handler) => handler(payload));
    }

    registerTransportHandlers() {
      this.transport.onMessage("player_joined", (message) => {
        if (this.transport.isHostPlayer()) this.addPlayer(message.playerId, message.playerName);
      });

      this.transport.onMessage("player_action", (message) => {
        if (this.transport.isHostPlayer()) {
          this.handleAction(message.playerId, message.action, message.payload || {});
        }
      });

      this.transport.onMessage("state_snapshot", (message) => {
        if (!this.transport.isHostPlayer()) {
          this.state = this.sanitizeSnapshot(message.state);
          this.emit("state", this.getState());
        }
      });

      this.transport.onMessage("private_role", (message) => {
        this.myRole = {
          role: message.role,
          isGood: message.isGood,
          knowledge: Array.isArray(message.knowledge) ? message.knowledge : []
        };
        this.emit("role", { ...this.myRole });
      });

      this.transport.onMessage("game_notice", (message) => {
        this.emit("notice", message);
      });
    }

    configureHost(name) {
      const host = {
        id: this.transport.getCurrentPlayerId(),
        name: this.cleanName(name, "房主"),
        online: true,
        isHost: true
      };
      this.state = this.createInitialState();
      this.state.players = [host];
      this.roles = [];
      this.myRole = null;
      this.publishState("房間已建立");
    }

    configureGuest(name) {
      this.state = this.createInitialState();
      this.state.players = [{
        id: this.transport.getCurrentPlayerId(),
        name: this.cleanName(name, "玩家"),
        online: true,
        isHost: false
      }];
      this.roles = [];
      this.myRole = null;
      this.emit("state", this.getState());
    }

    cleanName(name, fallback) {
      const clean = String(name || "").trim().replace(/[<>]/g, "").slice(0, 16);
      return clean || fallback;
    }

    addPlayer(playerId, playerName) {
      if (this.state.phase !== PHASES.WAITING) {
        this.transport.sendToPlayer(playerId, {
          type: "game_notice",
          level: "error",
          message: "遊戲已開始，暫時無法加入"
        });
        return;
      }

      const existing = this.state.players.find((player) => player.id === playerId);
      if (existing) {
        existing.online = true;
        existing.name = this.cleanName(playerName, existing.name);
      } else {
        if (this.state.players.length >= 10) {
          this.transport.sendToPlayer(playerId, {
            type: "game_notice",
            level: "error",
            message: "房間已滿"
          });
          return;
        }
        this.state.players.push({
          id: playerId,
          name: this.cleanName(playerName, `玩家${String(playerId).slice(-4)}`),
          online: true,
          isHost: false
        });
      }

      this.publishState(`${this.playerName(playerId)} 加入房間`);
      this.emit("playerJoined", { playerId, playerName: this.playerName(playerId) });
    }

    disconnectPlayer(playerId) {
      const player = this.state.players.find((item) => item.id === playerId);
      if (!player) return;

      if (this.state.phase === PHASES.WAITING) {
        this.state.players = this.state.players.filter((item) => item.id !== playerId);
      } else {
        player.online = false;
      }
      this.publishState(`${player.name} 已離線`);
    }

    canStart() {
      return this.state.phase === PHASES.WAITING
        && this.state.players.length >= 5
        && this.state.players.length <= 10
        && this.state.players.every((player) => player.online);
    }

    startGame() {
      if (!this.transport.isHostPlayer()) return;
      if (!this.canStart()) {
        this.emit("notice", { level: "error", message: "需要 5–10 位在線玩家才能開始" });
        return;
      }

      const roleNames = this.shuffle([...ROLE_CONFIG[this.state.players.length]]);
      this.roles = this.state.players.map((player, index) => ({
        playerId: player.id,
        role: roleNames[index],
        isGood: GOOD_ROLES.has(roleNames[index])
      }));

      this.roles.forEach((roleInfo) => {
        this.transport.sendToPlayer(roleInfo.playerId, {
          type: "private_role",
          role: roleInfo.role,
          isGood: roleInfo.isGood,
          knowledge: this.getKnowledge(roleInfo)
        });
      });

      this.state.currentMission = 1;
      this.state.currentLeaderId = this.state.players[0].id;
      this.state.missionResults = [];
      this.state.winner = null;
      this.beginTeamSelection("角色已分配，第一輪任務開始");
    }

    shuffle(values) {
      for (let index = values.length - 1; index > 0; index -= 1) {
        const random = new Uint32Array(1);
        crypto.getRandomValues(random);
        const swapIndex = random[0] % (index + 1);
        [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
      }
      return values;
    }

    getKnowledge(roleInfo) {
      const findNames = (predicate) => this.roles
        .filter(predicate)
        .map((role) => this.playerName(role.playerId));

      if (roleInfo.role === "Merlin") {
        return findNames((role) => !role.isGood && role.role !== "Mordred");
      }
      if (roleInfo.role === "Percival") {
        return findNames((role) => role.role === "Merlin" || role.role === "Morgana");
      }
      if (!roleInfo.isGood && roleInfo.role !== "Oberon") {
        return findNames((role) => !role.isGood && role.role !== "Oberon" && role.playerId !== roleInfo.playerId);
      }
      return [];
    }

    submitAction(action, payload = {}) {
      const message = {
        type: "player_action",
        playerId: this.transport.getCurrentPlayerId(),
        action,
        payload
      };

      if (this.transport.isHostPlayer()) {
        this.handleAction(message.playerId, action, payload);
      } else {
        this.transport.send(message);
      }
    }

    handleAction(playerId, action, payload) {
      const player = this.state.players.find((item) => item.id === playerId && item.online);
      if (!player) return;

      if (action === "select_team") {
        this.selectTeam(playerId, payload.members);
      } else if (action === "mission_vote") {
        this.recordMissionVote(playerId, payload.success);
      } else if (action === "assassinate") {
        this.assassinate(playerId, payload.targetId);
      }
    }

    selectTeam(playerId, members) {
      if (this.state.phase !== PHASES.TEAM_SELECTION || playerId !== this.state.currentLeaderId) return;
      const required = this.getMissionSize();
      const uniqueMembers = Array.from(new Set(Array.isArray(members) ? members : []));
      const validIds = new Set(this.state.players.filter((player) => player.online).map((player) => player.id));

      if (uniqueMembers.length !== required || uniqueMembers.some((id) => !validIds.has(id))) {
        this.sendNotice(playerId, "請選擇正確數量的在線玩家");
        return;
      }

      this.state.phase = PHASES.MISSION_VOTE;
      this.state.selectedMembers = uniqueMembers;
      this.state.submittedVoteIds = [];
      this.pendingVotes = new Map();
      this.publishState(`第 ${this.state.currentMission} 輪隊伍已選定`);
    }

    recordMissionVote(playerId, success) {
      if (this.state.phase !== PHASES.MISSION_VOTE) return;
      if (!this.state.selectedMembers.includes(playerId) || this.state.submittedVoteIds.includes(playerId)) return;

      const role = this.roles.find((item) => item.playerId === playerId);
      const finalVote = role?.isGood ? true : Boolean(success);
      this.pendingVotes.set(playerId, finalVote);
      this.state.submittedVoteIds.push(playerId);
      this.publishState(`${this.state.submittedVoteIds.length} / ${this.state.selectedMembers.length} 人已提交`);

      if (this.state.submittedVoteIds.length === this.state.selectedMembers.length) {
        this.resolveMission();
      }
    }

    resolveMission() {
      const votes = Array.from(this.pendingVotes.values());
      const failVotes = votes.filter((vote) => !vote).length;
      const requiredFails = this.getRequiredFails();
      const success = failVotes < requiredFails;

      this.state.missionResults.push({
        mission: this.state.currentMission,
        success,
        failVotes,
        requiredFails,
        members: [...this.state.selectedMembers]
      });

      const score = this.getScore();
      if (score.good >= 3) {
        this.state.phase = PHASES.ASSASSINATION;
        this.state.selectedMembers = [];
        this.state.submittedVoteIds = [];
        this.publishState("三次任務成功，刺客獲得最後一次機會");
        return;
      }

      if (score.evil >= 3) {
        this.finishGame("evil", "邪惡陣營破壞了三次任務");
        return;
      }

      this.rotateLeader();
      this.state.currentMission += 1;
      this.beginTeamSelection(success ? "任務成功" : "任務失敗");
    }

    beginTeamSelection(message) {
      this.state.phase = PHASES.TEAM_SELECTION;
      this.state.selectedMembers = [];
      this.state.submittedVoteIds = [];
      this.pendingVotes = new Map();
      this.publishState(message);
    }

    rotateLeader() {
      const currentIndex = this.state.players.findIndex((player) => player.id === this.state.currentLeaderId);
      for (let offset = 1; offset <= this.state.players.length; offset += 1) {
        const candidate = this.state.players[(currentIndex + offset) % this.state.players.length];
        if (candidate.online) {
          this.state.currentLeaderId = candidate.id;
          return;
        }
      }
    }

    assassinate(playerId, targetId) {
      if (this.state.phase !== PHASES.ASSASSINATION) return;
      const actorRole = this.roles.find((role) => role.playerId === playerId);
      const targetRole = this.roles.find((role) => role.playerId === targetId);
      if (actorRole?.role !== "Assassin" || !targetRole) return;

      if (targetRole.role === "Merlin") {
        this.finishGame("evil", `刺客成功找出 ${this.playerName(targetId)}（梅林）`);
      } else {
        this.finishGame("good", `刺客誤判了 ${this.playerName(targetId)}，正義陣營獲勝`);
      }
    }

    finishGame(winner, message) {
      this.state.phase = PHASES.GAME_END;
      this.state.winner = winner;
      this.state.message = message;
      this.state.revealedRoles = this.roles.map((role) => ({
        playerId: role.playerId,
        role: role.role,
        isGood: role.isGood
      }));
      this.state.selectedMembers = [];
      this.state.submittedVoteIds = [];
      this.publishState(message);
      this.transport.broadcast({
        type: "game_notice",
        level: "result",
        message
      });
    }

    getMissionSize(mission = this.state.currentMission) {
      const sizes = MISSION_SIZES[this.state.players.length] || MISSION_SIZES[5];
      return sizes[Math.max(0, mission - 1)];
    }

    getRequiredFails() {
      return this.state.players.length >= 7 && this.state.currentMission === 4 ? 2 : 1;
    }

    getScore() {
      return {
        good: this.state.missionResults.filter((result) => result.success).length,
        evil: this.state.missionResults.filter((result) => !result.success).length
      };
    }

    getState() {
      return typeof structuredClone === "function"
        ? structuredClone(this.state)
        : JSON.parse(JSON.stringify(this.state));
    }

    sanitizeSnapshot(snapshot) {
      const next = this.createInitialState();
      return {
        ...next,
        ...snapshot,
        players: Array.isArray(snapshot?.players) ? snapshot.players : [],
        selectedMembers: Array.isArray(snapshot?.selectedMembers) ? snapshot.selectedMembers : [],
        submittedVoteIds: Array.isArray(snapshot?.submittedVoteIds) ? snapshot.submittedVoteIds : [],
        missionResults: Array.isArray(snapshot?.missionResults) ? snapshot.missionResults : [],
        revealedRoles: Array.isArray(snapshot?.revealedRoles) ? snapshot.revealedRoles : []
      };
    }

    publishState(message) {
      this.state.message = message || this.state.message;
      const snapshot = this.getState();
      this.emit("state", snapshot);
      if (this.transport.isHostPlayer()) {
        this.transport.broadcast({ type: "state_snapshot", state: snapshot });
      }
    }

    syncToPlayer(playerId) {
      if (!this.transport.isHostPlayer()) return;
      this.transport.sendToPlayer(playerId, {
        type: "state_snapshot",
        state: this.getState()
      });
    }

    sendNotice(playerId, message) {
      this.transport.sendToPlayer(playerId, {
        type: "game_notice",
        level: "error",
        message
      });
    }

    playerName(playerId) {
      return this.state.players.find((player) => player.id === playerId)?.name || "未知玩家";
    }

    getRoleForCurrentPlayer() {
      return this.myRole ? { ...this.myRole, knowledge: [...this.myRole.knowledge] } : null;
    }

    reset() {
      this.state = this.createInitialState();
      this.roles = [];
      this.myRole = null;
      this.emit("state", this.getState());
    }
  }

  global.AvalonGame = AvalonGame;
  global.AVALON_PHASES = PHASES;
})(window);
