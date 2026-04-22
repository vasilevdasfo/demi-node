// src/ui-server.js — minimal Observer UI over HTTP+WS on localhost
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');

const LOCAL_ORIGINS = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export class UiServer {
  constructor({ port = 4321, onRpc }) {
    this.port = port;
    this.onRpc = onRpc || (async () => ({ error: 'no handler' }));
    this.clients = new Set();
  }

  async start() {
    this.http = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, sock, head) => {
      const origin = req.headers.origin || '';
      if (origin && !LOCAL_ORIGINS.test(origin)) {
        sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); return;
      }
      this.wss.handleUpgrade(req, sock, head, (ws) => this._onWs(ws));
    });
    await new Promise((res) => this.http.listen(this.port, '127.0.0.1', res));
  }

  broadcast(event) {
    const raw = JSON.stringify(event);
    for (const c of this.clients) { try { c.send(raw); } catch {} }
  }

  async _handleHttp(req, res) {
    if (req.method !== 'GET') { res.statusCode = 405; return res.end(); }
    let url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const full = path.join(PUBLIC_DIR, url);
    if (!full.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end(); }
    try {
      const buf = await fs.readFile(full);
      res.statusCode = 200;
      res.setHeader('Content-Type', guessType(full));
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  }

  _onWs(ws) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'rpc') {
        const out = await this.onRpc(msg);
        try {
          ws.send(JSON.stringify({ type: 'rpc-reply', id: msg.id, ...out }));
        } catch {}
      }
    });
  }

  async stop() {
    for (const c of this.clients) try { c.close(); } catch {}
    this.wss?.close();
    await new Promise((res) => this.http?.close(res));
  }
}

function guessType(fp) {
  if (fp.endsWith('.html')) return 'text/html; charset=utf-8';
  if (fp.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (fp.endsWith('.css')) return 'text/css; charset=utf-8';
  if (fp.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
