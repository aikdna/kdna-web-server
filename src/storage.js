import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'asset.kdna'));
  return base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'asset.kdna';
}

export function createFileStorage(options = {}) {
  const storageDir = path.resolve(options.storageDir || path.join(os.tmpdir(), 'kdna-web-server'));
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;

  async function ensureDir() {
    await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });
  }

  async function put(file) {
    await ensureDir();
    const now = Date.now();
    await cleanup(now);

    const id = crypto.randomUUID();
    const originalName = sanitizeFileName(file?.name);
    const filePath = path.join(storageDir, `${id}.kdna`);
    const bytes = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, bytes, { mode: 0o600 });

    const meta = {
      id,
      originalName,
      path: filePath,
      size: bytes.length,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    await fs.writeFile(path.join(storageDir, `${id}.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
    return meta;
  }

  async function get(fileId) {
    const id = String(fileId || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      const err = new Error('Unknown KDNA fileId.');
      err.status = 404;
      err.code = 'KDNA_FILE_NOT_FOUND';
      throw err;
    }

    const metaPath = path.join(storageDir, `${id}.json`);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      const err = new Error('Unknown KDNA fileId.');
      err.status = 404;
      err.code = 'KDNA_FILE_NOT_FOUND';
      throw err;
    }

    if (Date.parse(meta.expiresAt) <= Date.now()) {
      await remove(id);
      const err = new Error('KDNA fileId expired.');
      err.status = 410;
      err.code = 'KDNA_FILE_EXPIRED';
      throw err;
    }
    return meta;
  }

  async function remove(fileId) {
    const id = String(fileId || '');
    await Promise.allSettled([
      fs.rm(path.join(storageDir, `${id}.kdna`), { force: true }),
      fs.rm(path.join(storageDir, `${id}.json`), { force: true }),
    ]);
  }

  async function cleanup(now = Date.now()) {
    let entries;
    try {
      entries = await fs.readdir(storageDir);
    } catch {
      return;
    }

    await Promise.all(entries.filter((entry) => entry.endsWith('.json')).map(async (entry) => {
      try {
        const metaPath = path.join(storageDir, entry);
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        if (Date.parse(meta.expiresAt) <= now) await remove(meta.id);
      } catch {
        await fs.rm(path.join(storageDir, entry), { force: true });
      }
    }));
  }

  return { put, get, remove, cleanup, storageDir };
}

export function createMemoryStorage() {
  const files = new Map();

  return {
    async put(file) {
      const id = crypto.randomUUID();
      const bytes = Buffer.from(await file.arrayBuffer());
      const meta = {
        id,
        originalName: sanitizeFileName(file?.name),
        path: `memory://${id}`,
        size: bytes.length,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        bytes,
      };
      files.set(id, meta);
      return meta;
    },
    async get(fileId) {
      const meta = files.get(String(fileId || ''));
      if (!meta) {
        const err = new Error('Unknown KDNA fileId.');
        err.status = 404;
        err.code = 'KDNA_FILE_NOT_FOUND';
        throw err;
      }
      return meta;
    },
    async remove(fileId) {
      files.delete(String(fileId || ''));
    },
    async cleanup() {},
    files,
  };
}
