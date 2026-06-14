(function () {
  "use strict";

  const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const ROLE_META = {
    Merlin: {
      name: "梅林",
      symbol: "✦",
      summary: "洞悉邪惡，卻必須隱藏自己。",
      description: "你知道多數邪惡角色的身分，但看不見莫德雷德。引導正義完成任務，同時避免被刺客發現。"
    },
    Percival: {
      name: "派西維爾",
      symbol: "◇",
      summary: "在兩個身影之間辨認真正的梅林。",
      description: "你會看到梅林與莫甘娜，但不知道誰是真正的梅林。觀察發言與任務選擇，保護正確的人。"
    },
    "Loyal Servant": {
      name: "忠誠侍從",
      symbol: "○",
      summary: "沒有特殊情報，只能相信推理。",
      description: "你是正義陣營。利用投票、任務結果和其他人的言行，找出潛伏在圓桌中的邪惡。"
    },
    Morgana: {
      name: "莫甘娜",
      symbol: "◆",
      summary: "偽裝成梅林，誤導派西維爾。",
      description: "你是邪惡陣營。派西維爾會把你和梅林同時視為候選者，善用這份混亂保護真正的刺客。"
    },
    Mordred: {
      name: "莫德雷德",
      symbol: "■",
      summary: "連梅林也無法看見的黑暗。",
      description: "你是邪惡陣營，而且不會出現在梅林的情報裡。保持低調通常比主動破壞更有價值。"
    },
    Oberon: {
      name: "奧伯倫",
      symbol: "⬡",
      summary: "孤立的邪惡，不認識其他同伴。",
      description: "你是邪惡陣營，但你看不到其他邪惡角色，他們也看不到你。你必須獨自判斷局勢。"
    },
    Assassin: {
      name: "刺客",
      symbol: "†",
      summary: "正義完成三次任務後，仍有最後一擊。",
      description: "你是邪惡陣營。如果正義完成三次任務，你可以刺殺一名玩家；找出梅林就能逆轉勝負。"
    }
  };

  class AvalonApp {
    constructor() {
      this.transport = new DomainRoomTransport();
      this.game = new AvalonGame(this.transport);
      this.roomCode = "";
      this.playerName = "";
      this.isHost = false;
      this.draftSelection = new Set();
      this.lastPhaseKey = "";
      this.qr = null;
      this.toastTimer = null;
      this.elements = {};

      this.cacheElements();
      this.bindEvents();
      this.bindTransport();
      this.bindGame();
      this.restoreLobby();
      this.renderMissionTrack(this.game.getState());
    }

    cacheElements() {
      const ids = [
        "lobbyScreen", "roomScreen", "gameScreen", "playerName", "roomCodeInput",
        "createRoomButton", "joinRoomButton", "inviteHint", "inviteRoomCode",
        "lobbyError", "connectionPill", "connectionLabel", "leaveRoomButton",
        "roomCodeDisplay", "inviteLink", "copyInviteButton", "shareInviteButton",
        "showQrButton", "qrPanel", "inviteQr", "playerCount", "minimumBadge",
        "roomPlayerList", "startGameButton", "hostNote", "chatMessages", "chatForm",
        "chatInput", "diagnosticLog", "gamePhaseEyebrow", "gamePhaseTitle",
        "missionTrack", "councilTitle", "selectionCounter", "councilGrid",
        "gameActionPanel", "roleSymbol", "roleName", "roleSummary", "goodScore",
        "evilScore", "roundHint", "openRoleButton", "revealRoleButton", "roleModal",
        "closeRoleModal", "understandRoleButton", "roleModalSymbol", "roleModalTitle",
        "roleModalDescription", "roleKnowledge", "toast"
      ];
      ids.forEach((id) => {
        this.elements[id] = document.getElementById(id);
      });
    }

    bindEvents() {
      this.elements.createRoomButton.addEventListener("click", () => this.createRoom());
      this.elements.joinRoomButton.addEventListener("click", () => this.joinRoom());
      this.elements.roomCodeInput.addEventListener("input", (event) => {
        event.target.value = this.normalizeRoomCode(event.target.value);
      });
      this.elements.roomCodeInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.joinRoom();
      });
      this.elements.playerName.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          if (this.elements.roomCodeInput.value) this.joinRoom();
          else this.createRoom();
        }
      });
      this.elements.leaveRoomButton.addEventListener("click", () => this.leaveRoom());
      this.elements.copyInviteButton.addEventListener("click", () => this.copyInvite());
      this.elements.shareInviteButton.addEventListener("click", () => this.shareInvite());
      this.elements.showQrButton.addEventListener("click", () => this.toggleQr());
      this.elements.startGameButton.addEventListener("click", () => this.game.startGame());
      this.elements.chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        this.sendChat();
      });
      [this.elements.openRoleButton, this.elements.revealRoleButton].forEach((button) => {
        button.addEventListener("click", () => this.openRoleModal());
      });
      [this.elements.closeRoleModal, this.elements.understandRoleButton].forEach((button) => {
        button.addEventListener("click", () => this.closeRoleModal());
      });
      this.elements.roleModal.addEventListener("click", (event) => {
        if (event.target === this.elements.roleModal) this.closeRoleModal();
      });
      window.addEventListener("beforeunload", () => this.transport.cleanup());
    }

    bindTransport() {
      this.transport.onStatus(({ status, detail }) => {
        this.setConnectionStatus(status, detail);
        this.log(detail || status, status === "error" ? "error" : status === "online" ? "success" : "");
      });

      this.transport.onConnect(({ playerId, playerName }) => {
        this.log(`已連線：${playerName}`, "success");
        if (this.isHost) {
          setTimeout(() => this.game.syncToPlayer(playerId), 100);
        }
      });

      this.transport.onDisconnect(({ playerId, playerName }) => {
        this.log(`連線中斷：${playerName}`, "error");
        if (this.isHost) this.game.disconnectPlayer(playerId);
        else this.toast("與房主的連線已中斷");
      });

      this.transport.onMessage("chat_send", (message) => {
        if (!this.isHost) return;
        const payload = {
          type: "chat_message",
          playerId: message.playerId,
          playerName: this.game.playerName(message.playerId),
          text: this.cleanChat(message.text)
        };
        if (!payload.text) return;
        this.addChatMessage(payload);
        this.transport.broadcast(payload);
      });

      this.transport.onMessage("chat_message", (message) => this.addChatMessage(message));
    }

    bindGame() {
      this.game.on("state", (state) => this.renderState(state));
      this.game.on("role", () => {
        this.renderRole();
        this.openRoleModal();
      });
      this.game.on("notice", (notice) => this.toast(notice.message || "系統訊息"));
      this.game.on("playerJoined", ({ playerName }) => {
        this.addSystemMessage(`${playerName} 加入圓桌`);
      });
    }

    restoreLobby() {
      const savedName = localStorage.getItem("avalon-player-name");
      if (savedName) this.elements.playerName.value = savedName;

      const params = new URLSearchParams(location.search);
      const invitedRoom = this.normalizeRoomCode(params.get("room"));
      if (invitedRoom) {
        this.elements.roomCodeInput.value = invitedRoom;
        this.elements.inviteRoomCode.textContent = invitedRoom;
        this.elements.inviteHint.classList.remove("hidden");
      }

      if (typeof Peer === "undefined") {
        this.showLobbyError("連線元件載入失敗，請確認網路後重新整理。");
      }
    }

    validateName() {
      const name = this.elements.playerName.value.trim().replace(/[<>]/g, "").slice(0, 16);
      if (!name) {
        this.showLobbyError("請先輸入玩家名稱。");
        this.elements.playerName.focus();
        return "";
      }
      localStorage.setItem("avalon-player-name", name);
      this.playerName = name;
      this.hideLobbyError();
      return name;
    }

    async createRoom() {
      const name = this.validateName();
      if (!name || typeof Peer === "undefined") return;
      this.setLobbyBusy(true);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const code = this.generateRoomCode();
        try {
          await this.transport.hostRoom(code, name);
          this.isHost = true;
          this.roomCode = code;
          this.game.configureHost(name);
          this.enterRoom();
          return;
        } catch (error) {
          if (attempt === 3) this.showLobbyError(error.message);
        }
      }
      this.setLobbyBusy(false);
    }

    async joinRoom() {
      const name = this.validateName();
      const code = this.normalizeRoomCode(this.elements.roomCodeInput.value);
      if (!name || typeof Peer === "undefined") return;
      if (code.length !== 6) {
        this.showLobbyError("請輸入完整的 6 碼房號。");
        return;
      }

      this.setLobbyBusy(true);
      try {
        this.isHost = false;
        this.roomCode = code;
        this.game.configureGuest(name);
        await this.transport.joinRoom(code, name);
        this.enterRoom();
      } catch (error) {
        this.transport.cleanup();
        this.game.reset();
        this.isHost = false;
        this.roomCode = "";
        this.showScreen("lobby");
        this.updateUrl(code);
        this.showLobbyError(error.message);
        this.setLobbyBusy(false);
      }
    }

    enterRoom() {
      this.setLobbyBusy(false);
      this.elements.roomCodeDisplay.textContent = this.roomCode;
      this.elements.inviteLink.value = this.buildInviteUrl();
      this.elements.qrPanel.classList.add("hidden");
      this.elements.showQrButton.textContent = "顯示 QR";
      this.updateUrl(this.roomCode);
      this.showScreen("room");
      this.addSystemMessage(this.isHost ? "房間已建立，等待玩家加入" : `正在進入房間 ${this.roomCode}`);
      this.renderState(this.game.getState());
    }

    leaveRoom() {
      this.transport.cleanup();
      this.game.reset();
      this.isHost = false;
      this.roomCode = "";
      this.draftSelection.clear();
      this.elements.chatMessages.innerHTML = "";
      this.elements.diagnosticLog.innerHTML = "";
      this.updateUrl("");
      this.showScreen("lobby");
      this.setLobbyBusy(false);
    }

    renderState(state) {
      const phaseKey = `${state.phase}:${state.currentMission}`;
      if (phaseKey !== this.lastPhaseKey) {
        this.draftSelection.clear();
        this.lastPhaseKey = phaseKey;
      }

      if (state.phase === AVALON_PHASES.WAITING) {
        if (this.roomCode) this.showScreen("room");
        this.renderRoom(state);
      } else {
        this.showScreen("game");
        this.renderGame(state);
      }
    }

    renderRoom(state) {
      const count = state.players.length;
      this.elements.playerCount.textContent = count;
      const remaining = Math.max(0, 5 - count);
      this.elements.minimumBadge.textContent = remaining ? `還需 ${remaining} 人` : "可以開始";
      this.elements.minimumBadge.classList.toggle("ready", remaining === 0 && count <= 10);

      this.elements.roomPlayerList.innerHTML = "";
      state.players.forEach((player) => {
        const chip = document.createElement("div");
        chip.className = "player-chip";
        const avatar = document.createElement("div");
        avatar.className = "player-avatar";
        avatar.textContent = player.name.charAt(0).toUpperCase();
        const copy = document.createElement("div");
        copy.className = "player-chip-copy";
        const name = document.createElement("strong");
        name.textContent = player.name;
        const status = document.createElement("small");
        status.textContent = `${player.isHost ? "房主 · " : ""}${player.online ? "在線" : "離線"}`;
        copy.append(name, status);
        chip.append(avatar, copy);
        this.elements.roomPlayerList.appendChild(chip);
      });

      this.elements.startGameButton.classList.toggle("hidden", !this.isHost);
      this.elements.startGameButton.disabled = !this.game.canStart();
      this.elements.hostNote.textContent = this.isHost
        ? count < 5 ? `還需要 ${5 - count} 位玩家` : "人數已足夠，可以開始。"
        : "等待房主開始遊戲。";
    }

    renderGame(state) {
      this.renderMissionTrack(state);
      this.renderRole();
      this.renderCouncil(state);
      const score = {
        good: state.missionResults.filter((result) => result.success).length,
        evil: state.missionResults.filter((result) => !result.success).length
      };
      this.elements.goodScore.textContent = score.good;
      this.elements.evilScore.textContent = score.evil;
      this.elements.roundHint.textContent = state.message;
    }

    renderMissionTrack(state) {
      this.elements.missionTrack.innerHTML = "";
      const count = Math.max(5, state.currentMission || 0);
      for (let mission = 1; mission <= count; mission += 1) {
        const node = document.createElement("div");
        node.className = "mission-node";
        const result = state.missionResults.find((item) => item.mission === mission);
        if (result) node.classList.add(result.success ? "success" : "fail");
        else if (mission === state.currentMission) node.classList.add("current");
        const label = document.createElement("span");
        label.textContent = `任務 ${mission}`;
        const value = document.createElement("strong");
        value.textContent = result ? (result.success ? "成功" : "失敗") : "—";
        node.append(label, value);
        this.elements.missionTrack.appendChild(node);
      }
    }

    renderCouncil(state) {
      const myId = this.transport.getCurrentPlayerId();
      const isLeader = state.currentLeaderId === myId;
      const missionSize = this.game.getMissionSize(state.currentMission);
      const myRole = this.game.getRoleForCurrentPlayer();
      const isAssassin = myRole?.role === "Assassin";

      const phaseLabels = {
        TEAM_SELECTION: ["組隊階段", isLeader ? "由你選擇任務成員" : `等待 ${this.game.playerName(state.currentLeaderId)} 組隊`],
        MISSION_VOTE: ["任務密議", "任務成員秘密提交成功或失敗"],
        ASSASSINATION: ["刺殺階段", isAssassin ? "找出梅林，逆轉戰局" : "等待刺客做出最後選擇"],
        GAME_END: ["遊戲結束", state.winner === "good" ? "正義陣營獲勝" : "邪惡陣營獲勝"]
      };
      const [eyebrow, title] = phaseLabels[state.phase] || ["圓桌議會", "遊戲進行中"];
      this.elements.gamePhaseEyebrow.textContent = eyebrow;
      this.elements.gamePhaseTitle.textContent = title;
      this.elements.councilTitle.textContent = state.phase === AVALON_PHASES.TEAM_SELECTION
        ? `第 ${state.currentMission} 輪：選擇 ${missionSize} 人`
        : title;

      this.elements.selectionCounter.textContent = state.phase === AVALON_PHASES.TEAM_SELECTION
        ? `${this.draftSelection.size} / ${missionSize}`
        : state.phase === AVALON_PHASES.MISSION_VOTE
          ? `${state.submittedVoteIds.length} / ${state.selectedMembers.length} 已提交`
          : "戰局進行中";

      this.elements.councilGrid.innerHTML = "";
      state.players.forEach((player) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "council-player";
        if (player.id === myId) card.classList.add("me");
        if (this.draftSelection.has(player.id) || state.selectedMembers.includes(player.id)) {
          card.classList.add("selected");
        }

        const canSelectTeam = state.phase === AVALON_PHASES.TEAM_SELECTION && isLeader && player.online;
        const canAssassinate = state.phase === AVALON_PHASES.ASSASSINATION && isAssassin && player.online && player.id !== myId;
        if (canSelectTeam || canAssassinate) {
          card.classList.add("selectable");
          card.addEventListener("click", () => {
            if (canAssassinate) {
              this.draftSelection.clear();
              this.draftSelection.add(player.id);
            } else {
              if (this.draftSelection.has(player.id)) this.draftSelection.delete(player.id);
              else if (this.draftSelection.size < missionSize) this.draftSelection.add(player.id);
            }
            this.renderCouncil(state);
          });
        }

        const avatar = document.createElement("div");
        avatar.className = "player-avatar";
        avatar.textContent = player.name.charAt(0).toUpperCase();
        const name = document.createElement("strong");
        name.textContent = player.name;
        const detail = document.createElement("small");
        const revealed = state.revealedRoles.find((role) => role.playerId === player.id);
        detail.textContent = revealed
          ? ROLE_META[revealed.role]?.name || revealed.role
          : `${player.id === state.currentLeaderId ? "隊長 · " : ""}${player.online ? "在線" : "離線"}`;
        if (player.id === state.currentLeaderId && !revealed) detail.classList.add("leader-crown");
        card.append(avatar, name, detail);
        this.elements.councilGrid.appendChild(card);
      });

      this.renderGameActions(state, { isLeader, isAssassin, missionSize, myRole, myId });
    }

    renderGameActions(state, context) {
      const panel = this.elements.gameActionPanel;
      panel.innerHTML = "";

      if (state.phase === AVALON_PHASES.TEAM_SELECTION && context.isLeader) {
        const button = this.actionButton(
          `確認這 ${context.missionSize} 位成員`,
          this.draftSelection.size !== context.missionSize,
          () => this.game.submitAction("select_team", { members: Array.from(this.draftSelection) })
        );
        panel.appendChild(button);
        return;
      }

      if (state.phase === AVALON_PHASES.MISSION_VOTE) {
        const selected = state.selectedMembers.includes(context.myId);
        const submitted = state.submittedVoteIds.includes(context.myId);
        if (!selected) {
          panel.appendChild(this.actionNote("你不在本輪任務隊伍中，等待成員秘密投票。"));
        } else if (submitted) {
          panel.appendChild(this.actionNote("你的選擇已密封送出，等待其他任務成員。"));
        } else {
          const grid = document.createElement("div");
          grid.className = "vote-choice-grid";
          const success = document.createElement("button");
          success.className = "vote-button success";
          success.textContent = "任務成功";
          success.addEventListener("click", () => this.game.submitAction("mission_vote", { success: true }));
          const fail = document.createElement("button");
          fail.className = "vote-button fail";
          fail.textContent = context.myRole?.isGood ? "正義不可失敗" : "任務失敗";
          fail.disabled = Boolean(context.myRole?.isGood);
          fail.addEventListener("click", () => this.game.submitAction("mission_vote", { success: false }));
          grid.append(success, fail);
          panel.appendChild(grid);
        }
        return;
      }

      if (state.phase === AVALON_PHASES.ASSASSINATION && context.isAssassin) {
        const targetId = Array.from(this.draftSelection)[0];
        const targetName = state.players.find((player) => player.id === targetId)?.name;
        panel.appendChild(this.actionButton(
          targetName ? `刺殺 ${targetName}` : "先選擇刺殺目標",
          !targetId,
          () => {
            if (confirm(`確定刺殺 ${targetName}？此選擇無法撤回。`)) {
              this.game.submitAction("assassinate", { targetId });
            }
          }
        ));
        return;
      }

      if (state.phase === AVALON_PHASES.GAME_END) {
        panel.appendChild(this.actionNote(state.message));
        return;
      }

      panel.appendChild(this.actionNote(state.message || "等待其他玩家操作。"));
    }

    actionButton(text, disabled, onClick) {
      const button = document.createElement("button");
      button.className = "primary-button full-width";
      button.textContent = text;
      button.disabled = disabled;
      button.addEventListener("click", onClick);
      return button;
    }

    actionNote(text) {
      const note = document.createElement("div");
      note.className = "action-note";
      note.textContent = text;
      return note;
    }

    renderRole() {
      const role = this.game.getRoleForCurrentPlayer();
      if (!role) {
        this.elements.roleSymbol.textContent = "?";
        this.elements.roleName.textContent = "尚未揭曉";
        this.elements.roleSummary.textContent = "遊戲開始後，身分只會顯示在你的裝置上。";
        return;
      }
      const meta = ROLE_META[role.role] || { name: role.role, symbol: "?", summary: "" };
      this.elements.roleSymbol.textContent = meta.symbol;
      this.elements.roleName.textContent = meta.name;
      this.elements.roleSummary.textContent = meta.summary;
    }

    openRoleModal() {
      const role = this.game.getRoleForCurrentPlayer();
      if (!role) {
        this.toast("身分尚未分配");
        return;
      }
      const meta = ROLE_META[role.role];
      this.elements.roleModalSymbol.textContent = meta.symbol;
      this.elements.roleModalTitle.textContent = meta.name;
      this.elements.roleModalDescription.textContent = meta.description;
      if (role.knowledge.length) {
        this.elements.roleKnowledge.textContent = `你的情報：${role.knowledge.join("、")}`;
        this.elements.roleKnowledge.classList.remove("hidden");
      } else {
        this.elements.roleKnowledge.classList.add("hidden");
      }
      this.elements.roleModal.classList.remove("hidden");
    }

    closeRoleModal() {
      this.elements.roleModal.classList.add("hidden");
    }

    sendChat() {
      const text = this.cleanChat(this.elements.chatInput.value);
      if (!text) return;
      const payload = {
        playerId: this.transport.getCurrentPlayerId(),
        playerName: this.playerName,
        text
      };
      if (this.isHost) {
        const message = { type: "chat_message", ...payload };
        this.addChatMessage(message);
        this.transport.broadcast(message);
      } else {
        this.transport.send({ type: "chat_send", ...payload });
      }
      this.elements.chatInput.value = "";
    }

    cleanChat(text) {
      return String(text || "").trim().replace(/[<>]/g, "").slice(0, 120);
    }

    addChatMessage(message) {
      const item = document.createElement("div");
      item.className = "chat-message";
      if (message.playerId === this.transport.getCurrentPlayerId()) item.classList.add("mine");
      const author = document.createElement("b");
      author.textContent = message.playerName || "玩家";
      const text = document.createElement("span");
      text.textContent = message.text || "";
      item.append(author, text);
      this.elements.chatMessages.appendChild(item);
      this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    addSystemMessage(text) {
      const item = document.createElement("div");
      item.className = "chat-message system";
      item.textContent = text;
      this.elements.chatMessages.appendChild(item);
      this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    buildInviteUrl() {
      const url = new URL(location.href);
      url.search = "";
      url.hash = "";
      url.searchParams.set("room", this.roomCode);
      return url.toString();
    }

    updateUrl(roomCode) {
      const url = new URL(location.href);
      url.search = "";
      url.hash = "";
      if (roomCode) url.searchParams.set("room", roomCode);
      history.replaceState({}, "", url);
    }

    async copyInvite() {
      try {
        await navigator.clipboard.writeText(this.elements.inviteLink.value);
        this.toast("邀請網址已複製");
      } catch (_) {
        this.elements.inviteLink.select();
        document.execCommand("copy");
        this.toast("邀請網址已複製");
      }
    }

    async shareInvite() {
      const data = {
        title: "加入阿瓦隆房間",
        text: `阿瓦隆房號 ${this.roomCode}`,
        url: this.elements.inviteLink.value
      };
      if (navigator.share) {
        try {
          await navigator.share(data);
          return;
        } catch (_) {}
      }
      this.copyInvite();
    }

    toggleQr() {
      const showing = !this.elements.qrPanel.classList.contains("hidden");
      this.elements.qrPanel.classList.toggle("hidden", showing);
      this.elements.showQrButton.textContent = showing ? "顯示 QR" : "隱藏 QR";
      if (!showing && !this.qr) {
        this.qr = new QRCode(this.elements.inviteQr, {
          text: this.elements.inviteLink.value,
          width: 190,
          height: 190,
          colorDark: "#111827",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
      }
    }

    setConnectionStatus(status, detail) {
      const mapped = status === "online" ? "online" : status === "error" ? "error" : status === "connecting" ? "connecting" : "offline";
      this.elements.connectionPill.dataset.state = mapped;
      this.elements.connectionLabel.textContent = detail || {
        online: "連線正常",
        error: "連線異常",
        connecting: "連線中",
        offline: "尚未連線"
      }[mapped];
    }

    setLobbyBusy(busy) {
      this.elements.createRoomButton.disabled = busy;
      this.elements.joinRoomButton.disabled = busy;
      this.elements.createRoomButton.textContent = busy ? "連線準備中…" : "＋ 建立新房間";
    }

    showLobbyError(message) {
      this.elements.lobbyError.textContent = message;
      this.elements.lobbyError.classList.remove("hidden");
    }

    hideLobbyError() {
      this.elements.lobbyError.classList.add("hidden");
    }

    showScreen(name) {
      this.elements.lobbyScreen.classList.toggle("hidden", name !== "lobby");
      this.elements.roomScreen.classList.toggle("hidden", name !== "room");
      this.elements.gameScreen.classList.toggle("hidden", name !== "game");
    }

    log(message, type = "") {
      if (!message) return;
      const entry = document.createElement("div");
      entry.className = `diagnostic-entry ${type}`;
      entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
      this.elements.diagnosticLog.appendChild(entry);
      this.elements.diagnosticLog.scrollTop = this.elements.diagnosticLog.scrollHeight;
    }

    toast(message) {
      clearTimeout(this.toastTimer);
      this.elements.toast.textContent = message;
      this.elements.toast.classList.remove("hidden");
      this.toastTimer = setTimeout(() => this.elements.toast.classList.add("hidden"), 2600);
    }

    generateRoomCode() {
      const random = new Uint32Array(6);
      crypto.getRandomValues(random);
      return Array.from(random, (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join("");
    }

    normalizeRoomCode(value) {
      return String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    window.avalonApp = new AvalonApp();
  });
})();
