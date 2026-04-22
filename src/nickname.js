// src/nickname.js — human-friendly node names
import fs from 'node:fs';
import { paths } from './paths.js';

const ADJ = [
  'eager', 'swift', 'quiet', 'bold', 'calm', 'wise', 'brave', 'loyal',
  'bright', 'keen', 'fierce', 'gentle', 'noble', 'sharp', 'steady', 'humble',
  'lucid', 'fluent', 'agile', 'candid', 'deft', 'sincere', 'valiant', 'prudent'
];

const NOUN = [
  'tiger', 'fox', 'owl', 'eagle', 'wolf', 'raven', 'lynx', 'hawk',
  'bear', 'otter', 'falcon', 'heron', 'badger', 'deer', 'elk', 'boar',
  'crane', 'swan', 'mink', 'marten', 'kite', 'stag', 'mole', 'shrike'
];

export function generateNickname() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const num = Math.floor(Math.random() * 99) + 1;
  return `${a}-${n}-${num}`;
}

export function loadNickname() {
  try {
    return fs.readFileSync(paths.nickname, 'utf8').trim();
  } catch {
    return null;
  }
}

export function saveNickname(nick) {
  const clean = String(nick).replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 40);
  fs.writeFileSync(paths.nickname, clean);
  return clean;
}

export function getOrCreateNickname() {
  let nick = loadNickname();
  if (!nick) {
    nick = generateNickname();
    saveNickname(nick);
  }
  return nick;
}
