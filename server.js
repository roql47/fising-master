const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
// 정적 파일 제공 설정
app.use(express.static(path.join(__dirname)));

// 루트 경로 처리
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

// Map: WebSocket → { userId, nickname, room }
const clients = new Map();
// Map: userId → { 물고기명: 개수 }
const inventories = new Map();
// Map: userId → 골드 (숫자)
const userGold = new Map();

const fishTable = [
  { name: '고등어', chance: 0.4, price: 10 },
  { name: '멸치', chance: 0.3, price: 5 },
  { name: '문어', chance: 0.2, price: 20 },
  { name: '쭈꾸미', chance: 0.1, price: 15 }
];

const DB_FILE = path.join(__dirname, 'db.json');

// 데이터베이스 파일(db.json)에서 기존 데이터를 불러오기
function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      let data = fs.readFileSync(DB_FILE, 'utf8');
      let db = JSON.parse(data);
      if (db.inventories) {
        for (const userId in db.inventories) {
          inventories.set(userId, db.inventories[userId]);
        }
      }
      if (db.userGold) {
        for (const userId in db.userGold) {
          userGold.set(userId, db.userGold[userId]);
        }
      }
      console.log('데이터베이스 로드 완료');
    } catch (e) {
      console.error("데이터베이스 로드 에러:", e);
    }
  }
}

// 현재 메모리 데이터를 db.json 파일에 저장하기
function saveDatabase() {
  let db = {
    inventories: Object.fromEntries(inventories),
    userGold: Object.fromEntries(userGold)
  };
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    // console.log('데이터베이스 저장 완료');
  } catch (e) {
    console.error("데이터베이스 저장 에러:", e);
  }
}

function getRandomFish() {
  const rand = Math.random();
  let total = 0;
  for (const fish of fishTable) {
    total += fish.chance;
    if (rand < total) return fish;
  }
  return fishTable[0];
}

function getTime() {
  return new Date().toLocaleTimeString();
}

function broadcast(room, messageObj) {
  const json = JSON.stringify(messageObj);
  for (const [client, info] of clients) {
    if (client.readyState === WebSocket.OPEN && info.room === room) {
      client.send(json);
    }
  }
}

function saveLog(room, content) {
  const logDir = path.join(__dirname, 'chatlogs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  const filePath = path.join(logDir, `${room}.txt`);
  fs.appendFileSync(filePath, content + '\n');
}

// 서버 시작 전에 기존 데이터 로드
loadDatabase();

// HTTP 서버 생성
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, request) => {
  // 연결 시 클라이언트의 IP 주소를 userId로 사용 (예: "::1", "xxx.xxx.xxx.xxx")
  const ip = request.socket.remoteAddress;
  // 클라이언트에게 join 요청 메시지 전송
  ws.send(JSON.stringify({ type: 'request_nickname' }));

  ws.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    // 사용자 정보 요청 (닉네임 클릭 시)
    if (parsed.type === 'requestUserInfo') {
      const targetUserId = parsed.targetUserId;
      const info = {
        type: 'userInfo',
        userId: targetUserId,
        inventory: inventories.get(targetUserId) || {},
        gold: userGold.get(targetUserId) || 0
      };
      ws.send(JSON.stringify(info));
      return;
    }

    // join 메시지 처리
    if (parsed.type === 'join') {
      const nickname = parsed.nickname;
      const room = parsed.room;
      const userId = ip; // 사용자의 고유 ID는 IP 주소로 설정

      // 동일 IP로 이미 접속 중인 기존 연결 있으면 종료
      for (const [client, info] of clients.entries()) {
        if (info.userId === userId && client !== ws) {
          client.send(JSON.stringify({ text: `⚠️ 다른 위치에서 접속되어 연결이 종료됩니다.` }));
          clients.delete(client);
          client.terminate();
        }
      }

      // 새 연결 등록 (기존 데이터는 유지)
      clients.set(ws, { userId, nickname, room });
      if (!inventories.has(userId)) {
        inventories.set(userId, {});
        saveDatabase();
      }
      if (!userGold.has(userId)) {
        userGold.set(userId, 0);
        saveDatabase();
      }

      // join 메시지에 userId 포함하여 브로드캐스트
      const joinMsg = {
        type: 'join',
        text: `[${getTime()}] 💬 ${nickname}님이 입장했습니다.`,
        userId,
        nickname
      };
      broadcast(room, joinMsg);
      return;
    }

    if (parsed.type === 'buy') {
      const info = clients.get(ws);
      if (!info) return;
      const { userId, nickname, room } = info;
      const { item, price } = parsed;
      const time = getTime();
      
      // 사용자의 골드 확인
      let gold = userGold.get(userId) || 0;
      
      if (gold < price) {
        // 골드가 부족한 경우
        ws.send(JSON.stringify({
          type: 'chat',
          text: `[${time}] ⚠️ 골드가 부족합니다. 필요: ${price}골드, 보유: ${gold}골드`
        }));
        return;
      }
      
      // 구매 처리
      if (item === '낡은 낚싯대') {
        // 골드 차감
        userGold.set(userId, gold - price);
        
        // 인벤토리에 낚싯대 추가
        const inv = inventories.get(userId);
        if (!inv['낚싯대']) {
          inv['낚싯대'] = 0;
        }
        inv['낚싯대'] += 1;
        
        // 데이터베이스 저장
        saveDatabase();
        
        // 구매 성공 메시지
        const result = `[${time}] 🎣 ${nickname}님이 낡은 낚싯대를 구매했습니다! (남은 골드: ${gold - price})`;
        saveLog(room, result);
        ws.send(JSON.stringify({ type: 'chat', text: result }));
        
        // 전체 방에 알림
        broadcast(room, {
          type: 'chat',
          text: `[${time}] 💰 ${nickname}님이 낡은 낚싯대를 구매했습니다!`
        });
      } else {
        // 존재하지 않는 아이템
        ws.send(JSON.stringify({
          type: 'chat',
          text: `[${time}] ⚠️ '${item}'은(는) 상점에 없는 아이템입니다.`
        }));
      }
      return;
    }

    if (parsed.type === 'message') {
      const info = clients.get(ws);
      if (!info) return;
      const { userId, nickname, room } = info;
      const text = parsed.text.trim();
      const time = getTime();

      // 🎣 낚시하기
      if (text === '낚시하기') {
        const fish = getRandomFish();
        const inv = inventories.get(userId);
        inv[fish.name] = (inv[fish.name] || 0) + 1;
        saveDatabase();
        const result = `[${time}] 🎣 ${nickname}님이 '${fish.name}'(을/를) 낚았습니다!`;
        saveLog(room, result);
        broadcast(room, { type: 'chat', text: result });
        return;
      }

      // 💰 판매
      if (text === '판매') {
        const inv = inventories.get(userId);
        let earned = 0;
        for (const fish of fishTable) {
          const count = inv[fish.name] || 0;
          earned += count * fish.price;
          inv[fish.name] = 0;
        }
        userGold.set(userId, userGold.get(userId) + earned);
        saveDatabase();
        const result = `[${time}] 💰 ${nickname}님이 ${earned}골드를 획득했습니다!`;
        saveLog(room, result);
        broadcast(room, { type: 'chat', text: result });
        return;
      }

      // 💰 특정 물고기 판매하기
      const sellMatch = text.match(/^판매하기\s+(\S+)\s+(\d+)$/);
      if (sellMatch) {
        const fishName = sellMatch[1];
        const quantity = parseInt(sellMatch[2]);
        const inv = inventories.get(userId);
        
        // 해당 물고기가 존재하는지 확인
        const fish = fishTable.find(f => f.name === fishName);
        if (!fish) {
          ws.send(JSON.stringify({
            type: 'chat',
            text: `[${time}] ⚠️ '${fishName}'은(는) 존재하지 않는 물고기입니다.`
          }));
          return;
        }
        
        // 해당 물고기를 충분히 보유하고 있는지 확인
        const currentCount = inv[fishName] || 0;
        if (currentCount < quantity) {
          ws.send(JSON.stringify({
            type: 'chat',
            text: `[${time}] ⚠️ ${fishName}을(를) ${quantity}개 판매하려면 최소한 ${quantity}개가 필요합니다. 현재 ${currentCount}개 보유 중.`
          }));
          return;
        }
        
        // 물고기 판매 및 골드 획득
        const earned = fish.price * quantity;
        inv[fishName] -= quantity;
        userGold.set(userId, userGold.get(userId) + earned);
        saveDatabase();
        
        const result = `[${time}] 💰 ${nickname}님이 ${fishName} ${quantity}마리를 판매하여 ${earned}골드를 획득했습니다!`;
        saveLog(room, result);
        broadcast(room, { type: 'chat', text: result });
        return;
      }
      
      // 일반 판매 명령어 안내
      if (text === '판매하기') {
        ws.send(JSON.stringify({
          type: 'chat',
          text: `[${time}] ℹ️ 사용법: '판매하기 [물고기이름] [수량]'. 예: '판매하기 고등어 5'`
        }));
        return;
      }

      // 📦 인벤토리 조회
      if (text === '인벤토리') {
        const inv = inventories.get(userId);
        const gold = userGold.get(userId);
        let summary = `[${time}] 📦 ${nickname}님의 인벤토리:\n`;
        for (const fish of fishTable) {
          summary += ` - ${fish.name}: ${inv[fish.name] || 0}마리\n`;
        }
        summary += ` - 💰 골드: ${gold}G`;
        broadcast(room, { type: 'chat', text: summary });
        return;
      }

      // 일반 채팅 메시지
      const formatted = `[${time}] ${nickname}: ${text}`;
      saveLog(room, formatted);
      broadcast(room, { type: 'chat', text: formatted });
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      const { nickname, room } = info;
      clients.delete(ws);
      const exitMsg = {
        type: 'leave',
        text: `[${getTime()}] ❌ ${nickname}님이 퇴장했습니다.`,
        nickname: nickname
      };
      broadcast(room, exitMsg);
    }
  });
});

// 서버 시작
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
