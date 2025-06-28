// server.ts - Deno-based merged HTTP & WebSocket server
import { serve } from "https://deno.land/std@0.195.0/http/server.ts";
import { extname, join, dirname, fromFileUrl } from "https://deno.land/std@0.195.0/path/mod.ts";
import { contentType } from "https://deno.land/std@0.195.0/media_types/mod.ts";

// Utility: 获取 Cookie 中的 nickname
function getCookieValue(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/nickname=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// 判断内网或回环地址
function internalNet(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('127.')) return true;
  if (ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('fe80:')) return true;
  return false;
}

// 键名管理
function getKey(ip: string, roomId: string | null): string {
  if (roomId) return roomId;
  return internalNet(ip) ? 'internal' : ip;
}

// 数据存储: Map<key, Array<用户>>
interface User { id: string; socket: WebSocket; targets: Record<string, unknown>; nickname: string | null }
const data = new Map<string, User[]>();

function registerUser(ip: string, roomId: string | null, socket: WebSocket, nickname: string | null): string {
  const key = getKey(ip, roomId);
  if (!data.has(key)) data.set(key, []);
  const room = data.get(key)!;
  let id: string;
  do {
    id = `${Math.floor(Math.random() * 1000000).toString().substring(3,5).padStart(2,'0')}${new Date().getMilliseconds().toString().padStart(3,'0')}`;
  } while (room.find(u => u.id === id));
  room.push({ id, socket, targets: {}, nickname });
  return id;
}

function unregisterUser(ip: string, roomId: string | null, id: string): void {
  const key = getKey(ip, roomId);
  const room = data.get(key);
  if (room) {
    const idx = room.findIndex(u => u.id === id);
    if (idx !== -1) room.splice(idx, 1);
  }
}

function getUserList(ip: string, roomId: string | null): User[] {
  return data.get(getKey(ip, roomId)) ?? [];
}

function getUser(ip: string, roomId: string | null, uid: string): User | undefined {
  return getUserList(ip, roomId).find(u => u.id === uid);
}

function updateNickname(ip: string, roomId: string | null, id: string, nickname: string): boolean {
  const user = getUser(ip, roomId, id);
  if (user) { user.nickname = nickname; return true; }
  return false;
}

// WebSocket 消息类型
const SEND = { REG: '1001', ROOM_INFO: '1002', JOINED: '1003', CANDIDATE: '1004', NEW_CONN: '1005', CONNECTED: '1006', NICK_UPDATED: '1007' };
const RECV = { CANDIDATE: '9001', NEW_CONN: '9002', CONNECTED: '9003', KEEPALIVE: '9999', UPDATE_NICK: '9004' };

// 房间密码配置加载
let roomPwd: Record<string, { pwd: string; turns: number }> = {};
try {
  const __dirname = dirname(fromFileUrl(import.meta.url));
  const cfgText = await Deno.readTextFile(join(__dirname, 'room_pwd.json'));
  const cfg = JSON.parse(cfgText) as Array<{ roomId: string; pwd: string; turns: number }>;
  for (const item of cfg) roomPwd[item.roomId] = { pwd: item.pwd, turns: item.turns };
  console.log('Loaded room IDs:', Object.keys(roomPwd).join(','));
} catch {
  // 无配置则忽略
}

// 服务器配置
const PORT = Number(Deno.args[0] ?? 8081);
// 静态资源目录：将静态文件放入 www 目录
const STATIC_DIR = join(dirname(fromFileUrl(import.meta.url)), 'www');

// 启动服务
console.log(`Server starting on port ${PORT}`);
serve(async (req, connInfo) => {
  const url = new URL(req.url);
  const ip = (connInfo.remoteAddr as Deno.NetAddr).hostname;

  // WebSocket 升级
  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const segments = url.pathname.split('/').filter(Boolean);
    let [roomId, pwd] = segments;
    if (roomId === 'ws' || !roomId || roomId.length > 32) roomId = null;
    if (segments.length > 1 && pwd && roomPwd[roomId!] && roomPwd[roomId!].pwd.toLowerCase() === pwd.toLowerCase()) {
      // 密码正确
    } else {
      pwd = null;
    }
    const turns = roomId && roomPwd[roomId]?.turns;
    const nickname = getCookieValue(req.headers.get('cookie'));
    const currentId = registerUser(ip, roomId, socket, nickname);

    // 初始推送
    send(socket, SEND.REG, { id: currentId, roomId, turns });
    console.log(`User connected: ${currentId}@${ip}${roomId ? '/'+roomId : ''}`);
    getUserList(ip, roomId).forEach(u => send(u.socket, SEND.ROOM_INFO,
      getUserList(ip, roomId).map(x => ({ id: x.id, nickname: x.nickname }))
    ));
    send(socket, SEND.JOINED, { id: currentId });

    socket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)); }
      catch { return; }
      const { uid, targetId, type, data } = msg;
      if (!type || !uid || !targetId) return;
      const me = getUser(ip, roomId, uid);
      const target = getUser(ip, roomId, targetId);
      if (!me || !target) return;

      switch (type) {
        case RECV.CANDIDATE:
          send(target.socket, SEND.CANDIDATE, { targetId: uid, candidate: data.candidate }); break;
        case RECV.NEW_CONN:
          send(target.socket, SEND.NEW_CONN, { targetId: uid, offer: data.targetAddr }); break;
        case RECV.CONNECTED:
          send(target.socket, SEND.CONNECTED, { targetId: uid, answer: data.targetAddr }); break;
        case RECV.KEEPALIVE:
          break;
        case RECV.UPDATE_NICK:
          if (updateNickname(ip, roomId, uid, data.nickname)) {
            getUserList(ip, roomId).forEach(u => send(u.socket, SEND.NICK_UPDATED, { id: uid, nickname: data.nickname }));
          }
          break;
      }
    };

    const closeHandler = () => {
      unregisterUser(ip, roomId, currentId);
      getUserList(ip, roomId).forEach(u => send(u.socket, SEND.ROOM_INFO,
        getUserList(ip, roomId).map(x => ({ id: x.id, nickname: x.nickname }))
      ));
      console.log(`User disconnected: ${currentId}@${ip}${roomId ? '/'+roomId : ''}`);
    };
    socket.onclose = closeHandler;
    socket.onerror = closeHandler;

    return response;
  }

  // 静态文件服务
  let pathname = new URL(req.url).pathname;
  if (pathname === "/") pathname = "/index.html";
  const filePath = join(STATIC_DIR, decodeURIComponent(pathname.substring(1)));
  try {
    const file = await Deno.readFile(filePath);
    const headers = new Headers();
    const ext = extname(filePath);
    headers.set('Content-Type', contentType(ext) || 'application/octet-stream');
    if (ext === '.js' || ext === '.css') {
      headers.set('Cache-Control', 'public, max-age=2592000');
    }
    return new Response(file, { status: 200, headers });
  } catch {
    // 如果请求的文件不存在，则返回 index.html
    const defaultPath = join(STATIC_DIR, 'index.html');
    const defaultFile = await Deno.readFile(defaultPath);
    const defaultHeaders = new Headers({ 'Content-Type': 'text/html' });
    return new Response(defaultFile, { status: 200, headers: defaultHeaders });
  }


}, { port: PORT });

// 发送工具
function send(socket: WebSocket, type: string, data: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, data }));
  }
}
