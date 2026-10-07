'use strict';
/**
 * 极简 JSON 文件存储。
 * 零依赖，启动即用，不引 sqlite，纯文件读写 + 内存索引。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/** 单个集合：加载到内存，写操作串行落盘 */
class Collection {
  constructor(name) {
    this.name = name;
    this.file = path.join(DATA_DIR, name + '.json');
    this.rows = [];
    this.loaded = false;
    this._writing = false;
    this._dirty = false;
  }

  load() {
    if (this.loaded) return this;
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.rows = Array.isArray(parsed) ? parsed : [];
      } else {
        this.rows = [];
      }
    } catch (err) {
      // 文件损坏时不阻塞启动：备份坏文件，用空集合继续
      try {
        fs.renameSync(this.file, this.file + '.corrupt-' + Date.now());
      } catch (_) { /* ignore */ }
      this.rows = [];
    }
    this.loaded = true;
    return this;
  }

  /** 原子写：先写临时文件再 rename，避免半截文件 */
  save() {
    this._dirty = true;
    if (this._writing) return;
    this._writing = true;
    setImmediate(() => {
      this._writing = false;
      if (!this._dirty) return;
      this._dirty = false;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.rows, null, 0), 'utf8');
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[store] 写入失败 ' + this.name + ':', err.message);
      }
    });
  }

  insert(row) {
    this.load();
    this.rows.push(row);
    this.save();
    return row;
  }

  update(id, patch) {
    this.load();
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    this.save();
    return row;
  }

  updateOne(fn, patch) {
    this.load();
    const row = this.rows.find(fn);
    if (!row) return null;
    Object.assign(row, patch);
    this.save();
    return row;
  }

  remove(id) {
    this.load();
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.rows.splice(idx, 1);
    this.save();
    return true;
  }

  find(id) {
    this.load();
    return this.rows.find((r) => r.id === id) || null;
  }

  /** 按任意条件查找单条（区别于 find 只认 id） */
  findOne(fn) {
    this.load();
    return this.rows.find(fn) || null;
  }

  filter(fn) {
    this.load();
    return this.rows.filter(fn);
  }

  all() {
    this.load();
    return this.rows;
  }

  count(fn) {
    this.load();
    return fn ? this.rows.filter(fn).length : this.rows.length;
  }
}

const db = {
  users: new Collection('users'),
  rooms: new Collection('rooms'),
  posts: new Collection('posts'),
  messages: new Collection('messages'),
  reports: new Collection('reports'),
  tokens: new Collection('tokens'),
  visits: new Collection('visits'),
  events: new Collection('events'),
  drafts: new Collection('drafts'),
  // 社交关系
  follows: new Collection('follows'),
  blocks: new Collection('blocks'),
  favorites: new Collection('favorites'),
};

/** 启动时确保所有集合已载入 */
db.init = function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  Object.keys(db).forEach((k) => {
    if (db[k] instanceof Collection) db[k].load();
  });
};

db.id = function id(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

module.exports = db;