/**
 * 文件用途：纯 Node.js 实现的 Electron ASAR 归档读写与补丁重打包模块。
 * 核心职责：解析 ASAR Pickle 文件头、读取内部文件、计算 SHA-256 分块完整性元数据，
 *          并在保留未修改文件原始字节及 unpacked/symlink 条目的前提下原子重打包。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ASAR 二进制头与完整性校验常量
const PICKLE_HEADER_BYTES = 16;
const SIZE_PICKLE_PAYLOAD = 4;
const PICKLE_PREFIX_BYTES = 8;
const PICKLE_ALIGN_MASK = 3;
const UINT32_BYTES = 4;
const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;
const HASH_ALGORITHM = 'SHA256';
const COPY_CHUNK_BYTES = 1024 * 1024;

/**
 * 计算文件内容的 SHA-256 整体哈希与 4MB 分块哈希，符合 Electron ASAR 规范。
 * @param {Buffer} contentBuf 待计算哈希的文件字节缓冲区
 * @returns {{ algorithm: string, hash: string, blockSize: number, blocks: string[] }}
 */
function computeIntegrity(contentBuf) {
  if (!Buffer.isBuffer(contentBuf)) {
    throw new TypeError('computeIntegrity 需要传入 Buffer 类型参数');
  }
  const fullHash = crypto.createHash('sha256').update(contentBuf).digest('hex');
  if (contentBuf.length === 0) {
    return {
      algorithm: HASH_ALGORITHM,
      hash: fullHash,
      blockSize: INTEGRITY_BLOCK_SIZE,
      blocks: [fullHash],
    };
  }
  const blocks = [];
  for (let start = 0; start < contentBuf.length; start += INTEGRITY_BLOCK_SIZE) {
    const end = Math.min(start + INTEGRITY_BLOCK_SIZE, contentBuf.length);
    const blockHash = crypto
      .createHash('sha256')
      .update(contentBuf.subarray(start, end))
      .digest('hex');
    blocks.push(blockHash);
  }
  return {
    algorithm: HASH_ALGORITHM,
    hash: fullHash,
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

/**
 * 读取并解析 ASAR 文件的 16 字节 Pickle 头部与 JSON 目录树。
 * @param {string} filePath ASAR 文件绝对路径
 * @returns {{ header: object, dataOffset: number }}
 */
function parseAsarHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const prefix = Buffer.alloc(PICKLE_HEADER_BYTES);
    const readPrefix = fs.readSync(fd, prefix, 0, PICKLE_HEADER_BYTES, 0);
    if (readPrefix !== PICKLE_HEADER_BYTES) {
      throw new Error(`ASAR 文件头长度不足: ${filePath}`);
    }
    const headerSize = prefix.readUInt32LE(UINT32_BYTES);
    const jsonByteLen = prefix.readUInt32LE(UINT32_BYTES * 3);
    const jsonBuf = Buffer.alloc(jsonByteLen);
    const readJson = fs.readSync(fd, jsonBuf, 0, jsonByteLen, PICKLE_HEADER_BYTES);
    if (readJson !== jsonByteLen) {
      throw new Error(`ASAR 目录 JSON 读取不完整: ${filePath}`);
    }
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, dataOffset: PICKLE_PREFIX_BYTES + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 将相对路径标准化为 POSIX 斜杠段数组，拒绝路径穿越片段。
 * @param {string} relPath ASAR 内部相对路径
 * @returns {string[]}
 */
function normalizeRelParts(relPath) {
  const parts = String(relPath).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((seg) => seg === '.' || seg === '..')) {
    throw new Error(`非法的 ASAR 内部路径: ${relPath}`);
  }
  return parts;
}

/**
 * 在解析后的 ASAR 目录树中查找指定相对路径对应的元数据节点。
 * @param {object} header ASAR 根目录对象
 * @param {string} relPath 内部相对路径
 * @returns {object | null}
 */
function resolveNode(header, relPath) {
  const parts = normalizeRelParts(relPath);
  let current = header;
  for (const part of parts) {
    if (!current || !current.files || !Object.prototype.hasOwnProperty.call(current.files, part)) {
      return null;
    }
    current = current.files[part];
  }
  return current;
}

/**
 * 从 ASAR 文件中读取指定内部打包文件的原始内容。
 * @param {string} filePath ASAR 文件路径
 * @param {string} relPath 内部相对路径
 * @returns {Buffer}
 */
function readAsarFile(filePath, relPath) {
  const { header, dataOffset } = parseAsarHeader(filePath);
  const node = resolveNode(header, relPath);
  if (!node || node.files) {
    throw new Error(`ASAR 中不存在文件: ${relPath}`);
  }
  if (node.unpacked) {
    throw new Error(`目标文件为 unpacked 外部文件，不在 ASAR 数据区中: ${relPath}`);
  }
  const offset = dataOffset + Number(node.offset);
  const content = Buffer.alloc(node.size);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, content, 0, node.size, offset);
    if (bytesRead !== node.size) {
      throw new Error(`读取 ASAR 文件字节不完整: ${relPath}`);
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 将目录树对象编码为符合 Chromium Pickle 4 字节对齐规范的头部缓冲块。
 * @param {object} header ASAR 目录树对象
 * @returns {{ prefixBuf: Buffer, jsonBuf: Buffer, padBuf: Buffer }}
 */
function encodeAsarHeader(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const alignedJsonLen = (jsonBuf.length + PICKLE_ALIGN_MASK) & ~PICKLE_ALIGN_MASK;
  const padLen = alignedJsonLen - jsonBuf.length;
  const stringPicklePayload = UINT32_BYTES + alignedJsonLen;
  const headerPickleSize = UINT32_BYTES + stringPicklePayload;

  const prefixBuf = Buffer.alloc(PICKLE_HEADER_BYTES);
  prefixBuf.writeUInt32LE(SIZE_PICKLE_PAYLOAD, 0);
  prefixBuf.writeUInt32LE(headerPickleSize, UINT32_BYTES);
  prefixBuf.writeUInt32LE(stringPicklePayload, UINT32_BYTES * 2);
  prefixBuf.writeUInt32LE(jsonBuf.length, UINT32_BYTES * 3);

  return { prefixBuf, jsonBuf, padBuf: Buffer.alloc(padLen) };
}

/**
 * 在新目录树中确保更新路径对应的父目录存在，并写入占位文件节点。
 * @param {object} rootNode 克隆后的根目录树
 * @param {string} relPath 内部相对路径
 * @param {Buffer} contentBuf 新文件内容
 */
function ensureUpdatePlaceholder(rootNode, relPath, contentBuf) {
  const parts = normalizeRelParts(relPath);
  let cursor = rootNode;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const dirName = parts[i];
    if (!cursor.files[dirName]) {
      cursor.files[dirName] = { files: {} };
    }
    cursor = cursor.files[dirName];
  }
  const fileName = parts[parts.length - 1];
  const prev = cursor.files[fileName];
  if (prev && prev.unpacked) {
    throw new Error(`不支持直接覆写 unpacked 条目: ${relPath}`);
  }
  cursor.files[fileName] = {
    size: contentBuf.length,
    offset: '0',
    integrity: computeIntegrity(contentBuf),
    ...(prev && prev.executable ? { executable: true } : {}),
  };
}

/**
 * 递归为所有内部打包文件重新分配连续 offset，并生成写入计划。
 * @param {object} node 当前目录树节点
 * @param {string} prefix 当前路径前缀
 * @param {object} state 遍历上下文（包含 updatesMap、cursorOffset、chunks）
 */
function layoutPackedNodes(node, prefix, state) {
  if (!node.files) {
    return;
  }
  for (const [name, entry] of Object.entries(node.files)) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.files) {
      layoutPackedNodes(entry, relPath, state);
      continue;
    }
    if (entry.unpacked || entry.link !== undefined) {
      continue;
    }
    const replacement = state.updatesMap.get(relPath);
    const assignedOffset = state.cursorOffset;
    if (replacement) {
      state.chunks.push({ type: 'buffer', buffer: replacement });
      entry.size = replacement.length;
      entry.offset = String(assignedOffset);
      entry.integrity = computeIntegrity(replacement);
      state.cursorOffset += replacement.length;
      continue;
    }
    state.chunks.push({
      type: 'slice',
      sourceOffset: state.sourceDataOffset + Number(entry.offset),
      size: entry.size,
    });
    entry.offset = String(assignedOffset);
    state.cursorOffset += entry.size;
  }
}

/**
 * 分块从源文件描述符复制指定范围字节到目标文件描述符，控制内存峰值。
 * @param {object} copyOpts 复制参数对象
 */
function copyFileSlice(copyOpts) {
  const { srcFd, dstFd, sourceOffset, size } = copyOpts;
  const buf = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(size, 1)));
  let remaining = size;
  let readPos = sourceOffset;
  while (remaining > 0) {
    const toRead = Math.min(remaining, buf.length);
    const actuallyRead = fs.readSync(srcFd, buf, 0, toRead, readPos);
    if (actuallyRead !== toRead) {
      throw new Error(`复制 ASAR 原始数据区失败，偏移量: ${readPos}`);
    }
    fs.writeSync(dstFd, buf, 0, actuallyRead);
    readPos += actuallyRead;
    remaining -= actuallyRead;
  }
}

/**
 * 基于源 ASAR 归档应用一组文件更新或新增，并原子输出到目标路径。
 * @param {{ sourcePath: string, targetPath: string, updates: Record<string, Buffer | string> }} options
 * @returns {{ updatedCount: number, totalDataBytes: number }}
 */
function rewriteAsar(options) {
  const { sourcePath, targetPath, updates } = options;
  if (!sourcePath || !targetPath || !updates) {
    throw new Error('rewriteAsar 必须提供 sourcePath、targetPath 与 updates');
  }
  const { header, dataOffset } = parseAsarHeader(sourcePath);
  const nextTree = JSON.parse(JSON.stringify(header));
  const updatesMap = new Map();

  for (const [rawPath, rawContent] of Object.entries(updates)) {
    const normalized = normalizeRelParts(rawPath).join('/');
    const buf = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(String(rawContent), 'utf8');
    updatesMap.set(normalized, buf);
    ensureUpdatePlaceholder(nextTree, normalized, buf);
  }

  const state = { updatesMap, sourceDataOffset: dataOffset, cursorOffset: 0, chunks: [] };
  layoutPackedNodes(nextTree, '', state);
  const { prefixBuf, jsonBuf, padBuf } = encodeAsarHeader(nextTree);

  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const srcFd = fs.openSync(sourcePath, 'r');
  const dstFd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(dstFd, prefixBuf);
    fs.writeSync(dstFd, jsonBuf);
    if (padBuf.length > 0) {
      fs.writeSync(dstFd, padBuf);
    }
    for (const chunk of state.chunks) {
      if (chunk.type === 'buffer') {
        fs.writeSync(dstFd, chunk.buffer);
      } else {
        copyFileSlice({ srcFd, dstFd, sourceOffset: chunk.sourceOffset, size: chunk.size });
      }
    }
  } catch (err) {
    fs.closeSync(dstFd);
    fs.closeSync(srcFd);
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
    throw err;
  }
  fs.closeSync(dstFd);
  fs.closeSync(srcFd);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.renameSync(tmpPath, targetPath);
  return { updatedCount: updatesMap.size, totalDataBytes: state.cursorOffset };
}

module.exports = Object.freeze({
  computeIntegrity,
  parseAsarHeader,
  resolveNode,
  readAsarFile,
  encodeAsarHeader,
  rewriteAsar,
});
