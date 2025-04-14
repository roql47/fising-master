const WebSocket = require('ws');

const statusText = document.getElementById('status');
const messages = document.getElementById('messages');
const form = document.getElementById('messageForm');
const input = document.getElementById('messageInput');
const nicknameInput = document.getElementById('nicknameInput');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinButton');
const userList = document.getElementById('userList');

let socket;
let currentUsers = new Set();

function updateUserList() {
  userList.innerHTML = '';
  currentUsers.forEach(user => {
    const li = document.createElement('li');
    li.className = 'user-item';
    li.textContent = user;
    userList.appendChild(li);
  });
}

function addMessage(msg, type = 'chat') {
  if (type === 'join' && msg.userId && msg.nickname) {
    // join 메시지: 닉네임을 클릭 가능하도록 표시
    const div = document.createElement('div');
    const timeMatch = msg.text.match(/^\[.*?\]/);
    const timeStr = timeMatch ? timeMatch[0] : '';
    const prefix = " 💬 ";
    const suffix = "님이 입장했습니다.";
    div.innerHTML = `${timeStr}${prefix}<span class="userNickname" data-userid="${msg.userId}">${msg.nickname}</span>${suffix}`;
    div.querySelector('.userNickname').onclick = function () {
      const targetUserId = this.getAttribute('data-userid');
      socket.send(JSON.stringify({ type: 'requestUserInfo', targetUserId }));
    };
    messages.appendChild(div);
    
    // 사용자 목록에 추가
    currentUsers.add(msg.nickname);
    updateUserList();
  } else if (type === 'leave' && msg.nickname) {
    // 사용자 목록에서 제거
    currentUsers.delete(msg.nickname);
    updateUserList();
  } else {
    const div = document.createElement('div');
    div.textContent = typeof msg === 'string' ? msg : msg.text;
    messages.appendChild(div);
  }
  messages.scrollTop = messages.scrollHeight;
}

joinBtn.onclick = () => {
  const nickname = nicknameInput.value.trim();
  const room = roomInput.value.trim() || '기본방';
  if (!nickname) return alert('닉네임을 입력하세요.');

  // 기존 연결이 있으면 닫기
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    socket.close();
  }

  socket = new WebSocket('ws://localhost:8080');

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'join', nickname, room }));
    statusText.innerHTML = '서버 연결 상태: <span style="color:green;">연결됨</span>';
    form.style.display = 'flex';
    input.focus();
  };

  socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      data = { type: 'chat', text: event.data };
    }
    if (data.type === 'join') {
      addMessage(data, 'join');
    } else if (data.type === 'leave') {
      addMessage(data, 'leave');
    } else if (data.type === 'userInfo') {
      // 사용자 정보를 alert로 표시 (IP, 인벤토리, 골드)
      alert(`IP 주소: ${data.userId}\n인벤토리: ${JSON.stringify(data.inventory)}\n골드: ${data.gold}`);
    } else {
      addMessage(data);
    }
  };

  socket.onclose = () => {
    statusText.innerHTML = '서버 연결 상태: <span style="color:red;">연결 종료</span>';
    addMessage('❌ 서버 연결 종료됨');
    form.style.display = 'none';
    currentUsers.clear();
    updateUserList();
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    socket.send(JSON.stringify({ type: 'message', text: input.value.trim() }));
    input.value = '';
  };
};