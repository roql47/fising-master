const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');

// MongoDB 연결 설정
let mongoConnected = false;

function connectToMongoDB() {
  mongoose.connect('mongodb+srv://roql47:'+encodeURIComponent('wiztech1')+'@cluster0.i5hmbzr.mongodb.net/?retryWrites=true&w=majority', {
    dbName: 'fishing_game',  // 명시적으로 데이터베이스 이름 지정
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 15000, // 서버 선택 타임아웃 15초
    socketTimeoutMS: 45000, // 소켓 타임아웃 45초
    connectTimeoutMS: 30000 // 연결 타임아웃 30초
  }).then(() => {
    console.log('MongoDB Atlas 연결 성공 - fishing_game 데이터베이스');
    mongoConnected = true;
  }).catch((err) => {
    console.error('MongoDB Atlas 연결 실패:', err);
    mongoConnected = false;
    // 10초 후에 재연결 시도
    setTimeout(connectToMongoDB, 10000);
  });
}

// 초기 연결 시도
connectToMongoDB();

// 연결 끊김 감지 및 재연결
mongoose.connection.on('disconnected', () => {
  console.log('MongoDB 연결이 끊어졌습니다. 재연결을 시도합니다...');
  mongoConnected = false;
  setTimeout(connectToMongoDB, 5000);
});

// 스키마 정의
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  uuid: { type: String, required: true, unique: true }
});

const inventorySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  items: { type: Map, of: Number, default: {} }
});

const goldSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  amount: { type: Number, default: 0 }
});

// 채팅 로그를 위한 스키마 추가
const chatLogSchema = new mongoose.Schema({
  room: { type: String, required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Inventory = mongoose.model('Inventory', inventorySchema);
const Gold = mongoose.model('Gold', goldSchema);
const ChatLog = mongoose.model('ChatLog', chatLogSchema);

const app = express();
// 정적 파일 제공 설정
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// 루트 경로에 대한 GET 요청 처리
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

// Map: WebSocket → { userId, nickname, room }
const clients = new Map();
// Map: userId → { 물고기명: 개수 }
const inventories = new Map();
// Map: userId → 골드 (숫자)
const userGold = new Map();
// Map: username → { password, uuid }
const users = new Map();

const fishTable = [
  { name: '고등어', chance: 0.4, price: 10 },
  { name: '멸치', chance: 0.3, price: 5 },
  { name: '문어', chance: 0.2, price: 20 },
  { name: '쭈꾸미', chance: 0.1, price: 15 }
];

const DB_FILE = path.join(__dirname, 'db.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// UUID 생성 함수
function generateUUID() {
  return crypto.randomUUID();
}

// 유저 데이터베이스에서 기존 유저 데이터를 불러오기
async function loadUsers() {
  try {
    const usersData = await User.find({});
    for (const user of usersData) {
      users.set(user.username, {
        password: user.password,
        uuid: user.uuid
      });
    }
    console.log('유저 데이터베이스 로드 완료');
  } catch (e) {
    console.error("유저 데이터베이스 로드 에러:", e);
  }
}

// 유저 데이터 저장
async function saveUsers() {
  try {
    for (const [username, data] of users) {
      await User.findOneAndUpdate(
        { username },
        { username, password: data.password, uuid: data.uuid },
        { upsert: true }
      );
    }
  } catch (e) {
    console.error("유저 데이터베이스 저장 에러:", e);
  }
}

// 회원가입 API
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '사용자 이름과 비밀번호를 모두 입력해야 합니다.' });
  }
  
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ success: false, message: '이미 존재하는 사용자 이름입니다.' });
    }
    
    const uuid = generateUUID();
    const user = new User({ username, password, uuid });
    await user.save();
    
    // 새 사용자를 위한 인벤토리 및 골드 초기화
    const inventory = new Inventory({ userId: uuid, items: {} });
    const gold = new Gold({ userId: uuid, amount: 0 });
    
    await inventory.save();
    await gold.save();
    
    // 메모리에도 추가
    users.set(username, { password, uuid });
    inventories.set(uuid, {});
    userGold.set(uuid, 0);
    
    return res.status(201).json({ success: true, message: '회원가입이 완료되었습니다.', uuid });
  } catch (e) {
    console.error('회원가입 에러:', e);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 로그인 API
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '사용자 이름과 비밀번호를 모두 입력해야 합니다.' });
  }
  
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });
    }
    
    if (user.password !== password) {
      return res.status(401).json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
    }
    
    // 메모리에도 추가
    users.set(username, { password: user.password, uuid: user.uuid });
    
    return res.status(200).json({ 
      success: true, 
      message: '로그인이 완료되었습니다.', 
      uuid: user.uuid,
      username: username
    });
  } catch (e) {
    console.error('로그인 에러:', e);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 데이터베이스에서 기존 데이터를 불러오기
async function loadDatabase() {
  try {
    const inventoriesData = await Inventory.find({});
    const goldData = await Gold.find({});
    
    for (const inv of inventoriesData) {
      inventories.set(inv.userId, inv.items);
    }
    
    for (const gold of goldData) {
      userGold.set(gold.userId, gold.amount);
    }
    
    console.log('데이터베이스 로드 완료');
  } catch (e) {
    console.error("데이터베이스 로드 에러:", e);
  }
}

// 현재 메모리 데이터를 MongoDB에 저장하기
async function saveDatabase() {
  if (!mongoConnected) {
    console.log('MongoDB 연결이 준비되지 않아 데이터베이스 저장을 건너뜁니다.');
    return;
  }

  try {
    const savePromises = [];
    
    // 인벤토리 저장
    for (const [userId, items] of inventories) {
      savePromises.push(
        Inventory.findOneAndUpdate(
          { userId },
          { userId, items },
          { upsert: true }
        ).catch(e => console.error(`인벤토리 저장 에러 (${userId}):`, e))
      );
    }
    
    // 골드 저장
    for (const [userId, amount] of userGold) {
      savePromises.push(
        Gold.findOneAndUpdate(
          { userId },
          { userId, amount },
          { upsert: true }
        ).catch(e => console.error(`골드 저장 에러 (${userId}):`, e))
      );
    }
    
    // 모든 저장 작업 병렬 처리
    await Promise.allSettled(savePromises);
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

// 채팅 로그 저장 함수 수정
async function saveLog(room, content) {
  // 로컬 파일 시스템에 저장
  try {
    const logDir = path.join(__dirname, 'chatlogs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    const filePath = path.join(logDir, `${room}.txt`);
    fs.appendFileSync(filePath, content + '\n');
  } catch (e) {
    console.error("채팅 로그 파일 저장 에러:", e);
  }
  
  // MongoDB에 저장 시도
  if (!mongoConnected) {
    console.log('MongoDB 연결이 준비되지 않아 채팅 로그 저장을 건너뜁니다.');
    return;
  }
  
  try {
    const chatLog = new ChatLog({ room, content });
    await chatLog.save();
  } catch (e) {
    console.error("채팅 로그 MongoDB 저장 에러:", e);
  }
}

// 채팅 로그 조회 API
app.get('/api/chatlogs/:room', async (req, res) => {
  try {
    const { room } = req.params;
    const logs = await ChatLog.find({ room }).sort({ timestamp: -1 }).limit(100);
    res.json({ success: true, logs });
  } catch (e) {
    console.error('채팅 로그 조회 에러:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 모든 채팅방 목록 조회 API
app.get('/api/chatrooms', async (req, res) => {
  try {
    const rooms = await ChatLog.distinct('room');
    res.json({ success: true, rooms });
  } catch (e) {
    console.error('채팅방 목록 조회 에러:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 서버 시작 전에 기존 데이터 로드
async function initializeServer() {
  try {
    // MongoDB 데이터 로드 시도 (실패해도 계속 진행)
    try {
      await loadDatabase();
      await loadUsers();
      console.log('MongoDB 데이터 로드 완료');
    } catch (e) {
      console.error('MongoDB 데이터 로드 실패, 서버는 로컬 메모리 데이터로 계속 실행됩니다:', e);
    }
    
    // HTTP 서버 생성
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (ws, request) => {
      // 연결 시 클라이언트의 IP 주소를 임시 userId로 사용 (실제 로그인 후 UUID로 대체됨)
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
          const uuid = parsed.uuid; // 로그인 후 받은 UUID
          const userId = uuid || ip; // UUID가 없으면 IP 사용 (비로그인 사용자)
          
          // 동일 ID와 동일 닉네임으로 이미 접속 중인 기존 연결이 있으면 종료
          for (const [client, info] of clients.entries()) {
            if (info.userId === userId && info.nickname === nickname && client !== ws) {
              client.send(JSON.stringify({ text: `⚠️ 다른 위치에서 ${nickname}으로 접속되어 연결이 종료됩니다.` }));
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

          // 모든 참여자 목록 생성
          const allUsers = [];
          for (const [, info] of clients) {
            if (info.room === room) {
              allUsers.push({ userId: info.userId, nickname: info.nickname });
            }
          }
          
          // 새 사용자에게 전체 사용자 목록 전송
          ws.send(JSON.stringify({ 
            type: 'full_user_list', 
            users: allUsers 
          }));

          // join 메시지에 userId 포함하여 브로드캐스트
          const joinMsg = {
            type: 'join',
            text: `[${getTime()}] 💬 ${nickname}님이 입장했습니다.`,
            userId,
            nickname
          };
          broadcast(room, joinMsg);
          
          // 모든 참여자에게 최신 참여자 목록 전송하기
          broadcast(room, { 
            type: 'full_user_list', 
            users: allUsers 
          });
          
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
            saveDatabase().catch(e => console.error("낚시 후 데이터베이스 저장 에러:", e));
            const result = `[${time}] 🎣 ${nickname}님이 '${fish.name}'(을/를) 낚았습니다!`;
            saveLog(room, result).catch(e => console.error("낚시 로그 저장 에러:", e));
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
            saveDatabase().catch(e => console.error("판매 후 데이터베이스 저장 에러:", e));
            const result = `[${time}] 💰 ${nickname}님이 ${earned}골드를 획득했습니다!`;
            saveLog(room, result).catch(e => console.error("판매 로그 저장 에러:", e));
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
            saveDatabase().catch(e => console.error("특정 물고기 판매 후 데이터베이스 저장 에러:", e));
            
            const result = `[${time}] 💰 ${nickname}님이 ${fishName} ${quantity}마리를 판매하여 ${earned}골드를 획득했습니다!`;
            saveLog(room, result).catch(e => console.error("특정 물고기 판매 로그 저장 에러:", e));
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
          saveLog(room, formatted).catch(e => console.error("일반 채팅 로그 저장 에러:", e));
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
          
          // 모든 참여자에게 최신 참여자 목록 전송하기
          const allUsers = [];
          for (const [, info] of clients) {
            if (info.room === room) {
              allUsers.push({ userId: info.userId, nickname: info.nickname });
            }
          }
          broadcast(room, { 
            type: 'full_user_list', 
            users: allUsers 
          });
        }
      });
    });
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
    });
  } catch (e) {
    console.error('서버 초기화 에러:', e);
    process.exit(1);
  }
}

initializeServer();
