// src/paths.js — filesystem layout
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const HOME = process.env.DEMI_HOME || path.join(os.homedir(), '.demi-node');

export const paths = {
  home: HOME,
  identity: path.join(HOME, 'identity.key'),
  identityPub: path.join(HOME, 'identity.pub'),
  nickname: path.join(HOME, 'nickname'),
  peersJson: path.join(HOME, 'peers.json'),
  chatDb: path.join(HOME, 'chat.db'),
  active: path.join(HOME, '.active'),
  lastSeen: path.join(HOME, '.last-seen'),
  log: path.join(HOME, 'node.log'),
  config: path.join(HOME, 'config.json'),
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function touchActive() {
  fs.writeFileSync(paths.active, String(Date.now()));
}

export function touchLastSeen() {
  fs.writeFileSync(paths.lastSeen, new Date().toISOString());
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    return {
      uiPort: 4321,
      lang: process.env.LANG?.slice(0, 2) || 'en',
      torMode: false,
      clubTopic: 'demi-club/v1',
      pairTtlMs: 10 * 60 * 1000,
      deadManDays: 30,
      referredBy: null,
    };
  }
}

export function saveConfig(cfg) {
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
