# Avalon

手機優先的阿瓦隆多人網頁遊戲。房主建立 6 碼房號後，玩家可透過邀請網址直接加入：

```text
https://game.axiospan.com/avalon/?room=ABC234
```

## 連線方式

- PeerJS 提供房間定位與 WebRTC signaling。
- 遊戲資料在玩家裝置間以 P2P 傳送。
- 房主是唯一的遊戲狀態權威，其他玩家只提交動作。
- QR code 僅包含邀請網址，不再交換 WebRTC SDP。
- 不需要帳號或後端資料庫。

> PeerJS 公共 signaling 服務只負責協助建立連線，不保存遊戲進度。部分嚴格 NAT 或企業網路仍可能阻擋 P2P。

## 遊戲流程

1. 輸入玩家名稱並建立房間。
2. 分享邀請網址、QR code 或 6 碼房號。
3. 集滿 5–10 人後，由房主開始遊戲。
4. 系統私下分配角色。
5. 隊長選擇任務成員，成員秘密提交任務結果。
6. 正義完成三次任務後，刺客可嘗試找出梅林。

## 核心檔案

```text
index.html    大廳、房間與遊戲畫面
style.css     響應式介面與視覺系統
transport.js  PeerJS 房號與 P2P 傳輸
game.js       房主權威的遊戲狀態與規則
app.js        UI 控制、邀請網址、聊天與畫面同步
```

其他 `test*.html`、`qr-test.html` 與舊版備份僅保留作歷史比對，不會部署到 Axiospan 遊戲廳。

## 本機執行

```powershell
python -m http.server 8765
```

開啟 `http://127.0.0.1:8765/`。PeerJS 與 QRCode.js 由 CDN 載入，因此建立網路房間仍需可連外。

## 部署

正式版同步至 `axiospan-games/avalon/`，由 GitHub 推送後交給 Vercel 自動部署：

- 遊戲廳：<https://game.axiospan.com/>
- Avalon：<https://game.axiospan.com/avalon/>

## 瀏覽器

建議使用最新版 Chrome、Edge、Firefox 或 Safari。必須在 HTTPS 或 localhost 環境執行 WebRTC。
