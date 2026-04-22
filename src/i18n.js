// src/i18n.js — minimal locale loader
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(HERE, '..', 'locales');

let cache = {};
let currentLang = 'en';
let fallback = {};

export function loadLocale(lang) {
  currentLang = lang || 'en';
  try {
    const fp = path.join(LOCALES_DIR, `${currentLang}.json`);
    cache = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    cache = {};
  }
  try {
    fallback = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  } catch {
    fallback = {};
  }
  return cache;
}

export function t(key, vars = {}) {
  let str = cache[key] ?? fallback[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v));
  }
  return str;
}

export function getLang() { return currentLang; }
