/**
 * dsh-video-notes / deps.js
 * 转写依赖检测与下载：yt-dlp、ffmpeg、whisper.cpp、whisper 模型。
 * 优先用配置里显式指定的路径，其次 PATH/常见安装位置，最后国内镜像下载到数据目录。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';

export function firstExisting(list) {
  for (const p of list) {
    if (!p) continue;
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

function whereExe(name) {
  try {
    const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) {
      const line = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (line) return line;
    }
  } catch { /* ignore */ }
  return '';
}

function listDirs(base) {
  try {
    return fs.readdirSync(base)
      .map(d => path.join(base, d))
      .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

/** 数据目录：存下载来的二进制与模型 */
export function dataDir(cfg) {
  if (cfg.dataDir) return cfg.dataDir;
  return path.join(os.homedir(), '.dsh', 'video-notes');
}

function binDir(cfg) { return path.join(dataDir(cfg), 'bin'); }
function modelDir(cfg) { return path.join(dataDir(cfg), 'model'); }

/** 检测四个工具，返回 { ytdlp, ffmpeg, whisper, model }（未找到为 ''） */
export function detectTools(cfg = {}) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const bin = binDir(cfg);
  const mdir = modelDir(cfg);

  // 数据目录里已下载的模型（任意 >1MB 的 .bin）
  let dlModel = '';
  if (fs.existsSync(mdir)) {
    try {
      dlModel = fs.readdirSync(mdir)
        .map(f => path.join(mdir, f))
        .find(f => /\.bin$/i.test(f) && fs.statSync(f).size > 1000000) || '';
    } catch { /* ignore */ }
  }

  const ytdlp = firstExisting([
    cfg.ytdlpPath,
    whereExe('yt-dlp'),
    path.join(bin, 'yt-dlp.exe'),
    path.join(local, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    path.join(local, 'Programs', 'yt-dlp', 'yt-dlp.exe'),
  ]);

  let ffmpeg = firstExisting([
    cfg.ffmpegPath,
    whereExe('ffmpeg'),
    path.join(bin, 'ffmpeg.exe'),
    path.join(bin, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ]);
  if (!ffmpeg) {
    const pkgRoot = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const pkg of listDirs(pkgRoot)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      for (const sub of listDirs(pkg)) {
        const cand = path.join(sub, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(cand)) { ffmpeg = cand; break; }
      }
      if (ffmpeg) break;
    }
  }

  const whisper = firstExisting([
    cfg.whisperPath,
    path.join(bin, 'whisper', 'Release', 'whisper-cli.exe'),
    path.join(bin, 'whisper', 'whisper-cli.exe'),
    path.join(bin, 'whisper-cli.exe'),
    'F:\\asr\\whisper-bin-x64\\Release\\whisper-cli.exe',
    'F:\\asr\\whisper-bin-blas\\Release\\whisper-cli.exe',
  ]);

  const model = firstExisting([
    cfg.modelPath,
    dlModel,
    path.join(mdir, 'ggml-large-v3-turbo-q5_0.bin'),
    path.join(mdir, 'ggml-medium.bin'),
    'F:\\asr\\ggml-large-v3-turbo-q5_0.bin',
    'F:\\asr\\ggml-medium.bin',
  ]);

  return { ytdlp, ffmpeg, whisper, model };
}

/* ---------------------------------------------------------------- 下载 */

async function downloadFile(url, dest, headers = {}, log = () => {}, signal) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await fetch(url, { headers, redirect: 'follow', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const out = fs.createWriteStream(tmp);
  const body = Readable.fromWeb(res.body);
  for await (const chunk of body) {
    got += chunk.length;
    out.write(chunk);
    if (total) log(`下载 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
  }
  out.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  await fsp.rename(tmp, dest);
  return dest;
}

async function extractZip(zipPath, destDir) {
  // Windows 10+ 自带 bsdtar（tar.exe），可直接解 zip
  await fsp.mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let err = '';
    child.stderr.on('data', c => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`解压失败（tar 退出码 ${code}）：${err.slice(0, 300)}`));
    });
  });
  await fsp.unlink(zipPath).catch(() => {});
}

/** 下载 whisper.cpp Windows 二进制（b5454 CI tag，x64 版）到数据目录 */
async function downloadWhisper(cfg, log) {
  const destZip = path.join(binDir(cfg), 'whisper-bin-x64.zip');
  const destDir = path.join(binDir(cfg), 'whisper');
  const assetId = '616096933'; // whisper-bin-x64.zip
  const url = `https://api.github.com/repos/ggml-org/whisper.cpp/releases/assets/${assetId}`;
  log('下载 whisper.cpp 二进制…');
  await downloadFile(url, destZip, { Accept: 'application/octet-stream' }, log);
  await extractZip(destZip, destDir);
  return firstExisting([
    path.join(destDir, 'Release', 'whisper-cli.exe'),
    path.join(destDir, 'whisper-cli.exe'),
  ]);
}

/** 下载 whisper 模型（hf-mirror 国内镜像） */
async function downloadModel(cfg, log) {
  const dest = path.join(modelDir(cfg), 'ggml-large-v3-turbo-q5_0.bin');
  const url = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin';
  log('下载 whisper 模型（约 547 MB，仅首次）…');
  await downloadFile(url, dest, {}, log);
  return dest;
}

/** 下载 yt-dlp.exe */
async function downloadYtdlp(cfg, log) {
  const dest = path.join(binDir(cfg), 'yt-dlp.exe');
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  log('下载 yt-dlp…');
  await downloadFile(url, dest, {}, log);
  return dest;
}

/** 下载 ffmpeg（gyan.dev essentials 静态版） */
async function downloadFfmpeg(cfg, log) {
  const destZip = path.join(binDir(cfg), 'ffmpeg.zip');
  const destDir = path.join(binDir(cfg), 'ffmpeg');
  const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  log('下载 ffmpeg（约 80 MB，仅首次）…');
  await downloadFile(url, destZip, {}, log);
  await extractZip(destZip, destDir);
  // 解压后是 ffmpeg-x.x.x-essentials_build/bin/ffmpeg.exe
  const ff = path.join(destDir, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(ff)) return ff;
  const found = (() => {
    const walk = (d) => {
      for (const e of listDirs(d)) {
        const c = path.join(e, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(c)) return c;
        const deep = walk(e);
        if (deep) return deep;
      }
      return '';
    };
    return walk(destDir);
  })();
  return found;
}

const MISSING_HINTS = {
  ytdlp: '未找到 yt-dlp。请安装 yt-dlp（winget install yt-dlp.yt-dlp），或在设置里指定 ytdlpPath。',
  ffmpeg: '未找到 ffmpeg。请安装（winget install Gyan.FFmpeg），或在设置里指定 ffmpegPath。',
  whisper: '未找到 whisper.cpp。将在首次使用时自动下载。',
  model: '未找到 whisper 模型。将在首次使用时自动下载。',
};

/**
 * 确保四个工具齐全；缺失时从国内镜像自动下载（模型/whisper/ffmpeg/yt-dlp）。
 * 返回完整路径对象。cfg 支持显式路径覆盖。
 */
export async function ensureTools(cfg = {}, log = () => {}) {
  const t = detectTools(cfg);
  const out = { ...t };
  if (!out.ytdlp) out.ytdlp = await downloadYtdlp(cfg, log);
  if (!out.ffmpeg) out.ffmpeg = await downloadFfmpeg(cfg, log);
  if (!out.whisper) out.whisper = await downloadWhisper(cfg, log);
  if (!out.model) out.model = await downloadModel(cfg, log);

  for (const k of ['ytdlp', 'ffmpeg', 'whisper', 'model']) {
    if (!out[k]) throw new Error(`${k} 依赖缺失：${MISSING_HINTS[k]}`);
  }
  return out;
}

/** 子进程执行封装：流式回传 stdout/stderr 行，支持取消 */
export function runProcess(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!exe || !fs.existsSync(exe)) return reject(new Error(`找不到可执行文件：${exe || '(未配置)'}`));
    const child = spawn(exe, args, {
      cwd: opts.cwd || undefined,
      windowsHide: true,
      env: { ...process.env, ...(opts.env || {}) },
    });
    let outBuf = '';
    let errBuf = '';
    let outLine = '';
    let errLine = '';
    const feed = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      if (isErr) { errBuf += text; errLine += text; }
      else { outBuf += text; outLine += text; }
      const pieces = (isErr ? errLine : outLine).split(/\r?\n|\r/);
      if (isErr) errLine = pieces.pop(); else outLine = pieces.pop();
      for (const p of pieces) {
        if (!p.trim()) continue;
        if (opts.onLine) { try { opts.onLine(p.trim()); } catch { /* ignore */ } }
      }
    };
    child.stdout.on('data', c => feed(c, false));
    child.stderr.on('data', c => feed(c, true));
    const onAbort = () => {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', err => { if (opts.signal) opts.signal.removeEventListener('abort', onAbort); reject(err); });
    child.on('close', code => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal && opts.signal.aborted) return reject(Object.assign(new Error('已取消'), { canceled: true }));
      if (code === 0) resolve({ stdout: outBuf, stderr: errBuf });
      else reject(new Error(`${path.basename(exe)} 退出码 ${code}${errBuf ? '：' + errBuf.slice(0, 300) : ''}`));
    });
  });
}
