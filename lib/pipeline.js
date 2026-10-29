/**
 * dsh-video-notes / pipeline.js
 * 流水线：解析元数据 → 下载视频 → 抽音轨 → whisper 转写 → LLM 生成笔记 → 落盘。
 * LLM 通过注入的 llmStream(ctx.llm.stream) 调用，与宿主解耦。
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from './deps.js';

export function sanitizeName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim();
}

export function fmtSec(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ' 小时 ' : '') + (h || m ? m + ' 分 ' : '') + sec + ' 秒';
}

export function noteFilename(job, prefix) {
  const title = job.title || '';
  const course = (title.match(/《([^》]+)》/) || [])[1] || '课程';
  const ver = (title.match(/(\d+\.\d+)\s*版/) || [])[1] || '';
  const pm = title.match(/[pP]\s*(\d+)\b/);
  const pno = pm ? pm[1] : '';
  let rest = '';
  if (pm) {
    rest = title.slice(pm.index + pm[0].length).trim();
    rest = rest.replace(/^[-–—:：\s]+/, '');
  }
  if (!rest) rest = title.replace(/《[^》]+》/, '').replace(/[pP]\s*\d+/, '').trim();
  const p = prefix ? String(prefix).trim() : '';
  const head = `${p}《${course}》${ver}`.trim();
  const parts = [head, pno ? `P${pno}` : '', rest, '笔记']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  return sanitizeName(parts) + '.md';
}

const SYSTEM_PROMPT = [
  '你是一位工科数学专业助教，任务是把课堂录音的转写稿整理成高质量的中文 markdown 学习笔记。',
  '',
  '硬性要求：',
  '1. 只用 markdown 和 Unicode 数学符号（例如 x₀、Δy、⊆、⇔、lim(x→x₀)）。**禁止** LaTeX：不要出现 $...$、\\(...\\)、\\frac、\\lim、\\times 之类。',
  '2. 定义、定理、结论、公式用 > 引用块单独突出；例题写完整步骤，不要只给结果。',
  '3. 结构固定（顺序不要换）：',
  '   # 标题；一张两列「项目｜内容」视频信息表（视频标题、链接、UP 主、时长、画质、合集分 P、笔记来源）；> 一句话总结（150 字内）；',
  '   正文分节 ## k. 小节名（带 (mm:ss) 时间戳），按讲课顺序展开；',
  '   ## 易错点（6–10 条，每条给出错法和对的做法）；## 术语中英对照（表格）；',
  '   ## 自测（3–4 题，题目后紧跟 <details><summary>答案</summary>...</details>）；',
  '   ## 时间轴（表格：时间｜内容，取转写稿里的真实时间戳）；## 与前后讲的衔接；## 说明（转写错字订正、与板书冲突之处、你的不确定项）。',
  '4. 篇幅 220–320 行，宁可展开不要凑数。',
  '5. 忠实于课堂内容：不要编造老师没讲的内容；转写稿里明显是语音识别错误的词（例如"影射→映射""直欲→值域""极线→极限""可散→cos""三页→sin""等加→等价"）按数学常识订正，并在「说明」里记录订正了哪些、依据是什么。',
  '6. 直接输出 markdown 全文，不要加代码围栏，不要写"以下是笔记"之类的前言。',
].join('\n');

export function srtChunks(srt, maxChars) {
  const blocks = srt.split(/\r?\n\r?\n/).filter(b => b.trim());
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const b of blocks) {
    if (size + b.length > maxChars && cur.length) {
      chunks.push(cur.join('\n\n'));
      cur = []; size = 0;
    }
    cur.push(b);
    size += b.length + 2;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

/** 把 content 统一成 content-block 数组（DSH LLM 只认 [{type:'text',text}]） */
function normalizeContent(messages) {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { ...m, content: [{ type: 'text', text: m.content }] };
    }
    return m;
  });
}

/** 用 llmStream 收齐一次完成的文本（累加 text-delta） */
export async function llmComplete(llmStream, messages, opts = {}) {
  const chunks = [];
  const stream = llmStream({
    provider: opts.provider,
    model: opts.model,
    messages: normalizeContent(messages),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
  });
  let text = '';
  for await (const c of stream) {
    if (c.type === 'text-delta') text += c.text;
    if (c.type === 'finish') {
      if (c.reason && c.reason.kind === 'error') {
        const f = c.reason.failure || {};
        throw new Error(`LLM 调用失败（${f.code || '未知错误'}）：${f.message || ''}`);
      }
      if (c.reason && c.reason.kind === 'aborted') throw new Error('LLM 调用被中止');
    }
  }
  chunks.length = 0;
  const out = text.trim();
  if (!out) throw new Error('LLM 返回内容为空');
  return out;
}

async function resolveMeta(job, cfg, deps, signal) {
  const args = ['-J', '--no-playlist', '--no-warnings', job.url];
  const r = await runProcess(deps.ytdlp, args, { cwd: cfg.media, signal });
  let info = {};
  try { info = JSON.parse(r.stdout); } catch { throw new Error('解析视频信息失败：返回不是有效 JSON'); }
  job.title = info.title || info.fulltitle || job.url;
  job.duration = Number(info.duration) || 0;
  job.uploader = info.uploader || info.channel || '';
  job.webpage = info.webpage_url || job.url;
  job.videoId = info.id || '';
  return info;
}

async function downloadVideo(job, cfg, deps, dir, signal) {
  const outTmpl = path.join(dir, 'video.%(ext)s');
  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--no-part',
    '--retries', '10', '--socket-timeout', '30',
    '-f', 'bv*[vcodec^=avc1][height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', deps.ffmpeg,
    '-o', outTmpl, job.url,
  ];
  await runProcess(deps.ytdlp, args, { cwd: dir, signal });
  const files = (await fsp.readdir(dir)).filter(f => /^video\.(mp4|mkv|webm|flv)$/i.test(f));
  if (!files.length) throw new Error('下载完成但没找到视频文件');
  return path.join(dir, files[0]);
}

async function extractWav(job, deps, videoPath, dir, signal) {
  const wav = path.join(dir, 'audio16k.wav');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav];
  await runProcess(deps.ffmpeg, args, { cwd: dir, signal });
  return wav;
}

async function transcribe(job, cfg, deps, wav, dir, signal) {
  const prefix = path.join(dir, 'transcript');
  const args = [
    '-m', deps.model,
    '-f', wav,
    '-l', cfg.language || 'zh',
    '-t', String(cfg.threads || 12),
    '-otxt', '-osrt',
    '-of', prefix,
    '-pp',
  ];
  await runProcess(deps.whisper, args, { cwd: dir, signal });
  const txt = await fsp.readFile(prefix + '.txt', 'utf8');
  let srt = '';
  try { srt = await fsp.readFile(prefix + '.srt', 'utf8'); } catch { /* ignore */ }
  if (!txt.trim()) throw new Error('转写结果为空');
  return { txt, srt };
}

async function buildNote(job, cfg, llmStream, txt, srt) {
  const durTxt = fmtSec(job.duration);
  const head = [
    `- 视频标题：${job.title}`,
    `- 链接：${job.webpage || job.url}`,
    `- UP 主：${job.uploader || '未知'}`,
    `- 时长：${durTxt}（${Math.round(job.duration)} 秒）`,
    '',
    '下面是这一讲的转写稿（带时间轴）。请据此写出完整笔记。',
  ].join('\n');

  const model = cfg.model || 'deepseek-flash';
  const provider = cfg.provider || 'deepseek-official';
  const LIMIT = 42000;
  let note;
  if (srt && srt.length > LIMIT) {
    const chunks = srtChunks(srt, LIMIT);
    const digests = [];
    for (let i = 0; i < chunks.length; i++) {
      digests.push(await llmComplete(llmStream, [
        { role: 'system', content: '你是数学助教，负责把课堂转写稿的片段整理成"精讲要点稿"：保留老师讲的每个定义、定理、例题的完整步骤、口述的易错提醒，按讲课顺序分小节，用 markdown，禁止 LaTeX。不要写前言。' },
        { role: 'user', content: `${head}\n\n（本段为全文第 ${i + 1}/${chunks.length} 段）\n\n${chunks[i]}` },
      ], { provider, model, maxTokens: 6000, temperature: cfg.temperature }));
    }
    note = await llmComplete(llmStream, [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          head, '',
          '下面是各段落的精讲要点稿。请整合成一篇完整的、结构符合要求的笔记（同一小节不要重复，按时间先后组织；保留所有定义、定理、例题步骤与易错提醒）。',
          '',
          ...digests.map((d, i) => `### 第 ${i + 1} 段要点\n${d}`),
        ].join('\n'),
      },
    ], { provider, model, maxTokens: 12000, temperature: cfg.temperature });
  } else {
    note = await llmComplete(llmStream, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${head}\n\n${srt || txt}` },
    ], { provider, model, maxTokens: 12000, temperature: cfg.temperature });
  }

  note = note.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  return note;
}

/**
 * 主流水线入口。
 * @param {object} p
 *   - p.url  视频链接（支持 ?p=N 分 P）
 *   - p.cfg  解析后的配置对象（含 media/notes/note.prefix/language/threads/provider/model/temperature/keepVideo）
 *   - p.deps 已 ensureTools 的工具路径 { ytdlp, ffmpeg, whisper, model }
 *   - p.llmStream  ctx.llm.stream 的绑定调用（fn(options) => AsyncIterable）
 *   - p.signal AbortSignal（agent 取消时中止）
 *   - p.log   fn(line) 进度日志（可选）
 * @returns { notePath, noteName, title, duration, note }
 */
/* ---------------------------------------------------------------- PDF */

function inlineMd(s) {
  const codes = [];
  s = String(s).replace(/`([^`]+)`/g, (m, c) => {
    codes.push('<code>' + c + '</code>');
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => codes[+n]);
  return s;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  const N = lines.length;
  const parseRow = (r) => {
    r = r.trim().replace(/^\|/, '').replace(/\|$/, '');
    r = r.replace(/\\\|/g, '\u0001');
    return r.split('|').map(c => c.trim().replace(/\u0001/g, '|'));
  };
  const isSep = (r) => /^\|[\s:\-|]+\|$/.test(r.trim());

  while (i < N) {
    const line = lines[i];
    if (/^<details>\s*$/.test(line)) {
      let buf = [];
      i++;
      while (i < N && !/^<\/details>\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      let inner = buf.join('\n');
      let summary = '参考答案';
      const m = inner.match(/^<summary>(.*?)<\/summary>/s);
      if (m) { summary = m[1]; inner = inner.slice(m[0].length); }
      const paras = inner.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      const body = paras.map(p => '<p>' + inlineMd(p).replace(/\n/g, '<br/>') + '</p>').join('\n');
      out.push('<div class="qa"><div class="qa-title">▸ ' + escHtml(summary) + '</div><div class="qa-body">' + body + '</div></div>');
      continue;
    }
    if (/^<summary>/.test(line) || /^<\/details>\s*$/.test(line)) { i++; continue; }
    if (/^```/.test(line)) {
      let buf = [];
      i++;
      while (i < N && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + escHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (/^---\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
    let h;
    if ((h = line.match(/^###\s+(.*)/))) { out.push('<h3>' + inlineMd(h[1]) + '</h3>'); i++; continue; }
    if ((h = line.match(/^##\s+(.*)/))) { out.push('<h2>' + inlineMd(h[1]) + '</h2>'); i++; continue; }
    if ((h = line.match(/^#\s+(.*)/))) { out.push('<h1>' + inlineMd(h[1]) + '</h1>'); i++; continue; }
    if (/^\|.*\|$/.test(line)) {
      const rows = [];
      while (i < N && /^\|.*\|$/.test(lines[i])) { rows.push(lines[i]); i++; }
      const header = parseRow(rows[0]);
      const body = rows.slice(1).filter(r => !isSep(r));
      let t = '<table><thead><tr>' + header.map(c => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of body) {
        t += '<tr>' + parseRow(r).map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>';
      }
      t += '</tbody></table>';
      out.push(t);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < N && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      const content = buf.map(b => b === '' ? '<br/>' : inlineMd(b)).join('');
      out.push('<blockquote>' + content + '</blockquote>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < N && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push('<ul>' + items.map(it => '<li>' + inlineMd(it) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < N && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      out.push('<ol>' + items.map(it => '<li>' + inlineMd(it) + '</li>').join('') + '</ol>');
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    out.push('<p>' + inlineMd(line) + '</p>');
    i++;
  }
  return out.join('\n');
}

const PDF_CSS = [
  '@page { size: A4; margin: 16mm 14mm; }',
  '* { box-sizing: border-box; }',
  'html, body { margin: 0; padding: 0; }',
  'body { font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", "Segoe UI Symbol", "Cambria Math", sans-serif; font-size: 11pt; line-height: 1.7; color: #1a1a1a; }',
  'h1 { font-size: 17pt; color: #1f4e79; border-bottom: 2px solid #2c6e9e; padding-bottom: 8px; margin: 0 0 14px; line-height: 1.35; }',
  'h2 { font-size: 13.5pt; color: #2c6e9e; margin: 18px 0 8px; padding-left: 9px; border-left: 4px solid #2c6e9e; page-break-after: avoid; }',
  'h3 { font-size: 12pt; color: #333; margin: 12px 0 6px; page-break-after: avoid; }',
  'p { margin: 6px 0; }',
  'table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 10pt; page-break-inside: auto; }',
  'th, td { border: 1px solid #c5c5c5; padding: 5px 8px; text-align: left; vertical-align: top; }',
  'th { background: #eef4f9; font-weight: 600; }',
  'tr { page-break-inside: avoid; }',
  'blockquote { margin: 8px 0; padding: 8px 12px; background: #f4f8fb; border-left: 4px solid #2c6e9e; color: #333; page-break-inside: avoid; }',
  'code { font-family: "Consolas", "Courier New", monospace; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 10pt; }',
  'pre { background: #f6f8fa; border: 1px solid #e1e4e8; padding: 10px 12px; border-radius: 4px; overflow-x: auto; page-break-inside: avoid; white-space: pre-wrap; }',
  'pre code { background: none; padding: 0; font-size: 10pt; }',
  'ul, ol { margin: 6px 0; padding-left: 24px; }',
  'li { margin: 3px 0; }',
  'hr { border: none; border-top: 1px solid #e0e0e0; margin: 14px 0; }',
  '.qa { background: #fbf7ef; border: 1px solid #e6d9b8; border-radius: 4px; padding: 8px 12px; margin: 10px 0; page-break-inside: avoid; }',
  '.qa-title { font-weight: 600; color: #8a6d1a; margin-bottom: 4px; }',
  '.qa-body p { margin: 4px 0; }',
].join('\n');

function noteToHtml(note, title) {
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>${escHtml(title)}</title>\n<style>${PDF_CSS}</style>\n</head>\n<body>\n${parseMarkdown(note)}\n</body>\n</html>`;
}

/** 找 Edge/Chrome 无头浏览器（Windows 常见安装位） */
export function findBrowser() {
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return '';
}

/** 把 markdown 笔记渲染成 PDF（Edge/Chrome headless --print-to-pdf） */
export async function noteToPdf(note, mdPath, browser, signal) {
  const htmlPath = mdPath.replace(/\.md$/i, '.html');
  const pdfPath = mdPath.replace(/\.md$/i, '.pdf');
  await fsp.writeFile(htmlPath, noteToHtml(note, path.basename(mdPath, '.md')), 'utf8');
  const fileUrl = pathToFileURL(htmlPath).href;
  const args = [
    '--headless', '--disable-gpu', '--no-pdf-header-footer',
    '--print-to-pdf=' + pdfPath,
    '--virtual-time-budget=8000',
    fileUrl,
  ];
  await runProcess(browser, args, { cwd: path.dirname(mdPath), signal });
  // 清理中间 HTML
  await fsp.unlink(htmlPath).catch(() => {});
  return pdfPath;
}

export async function runVideoToNotes(p) {
  const { url, cfg, deps, llmStream, signal, log = () => {} } = p;
  const job = {
    url: String(url || '').trim(),
    title: '', duration: 0, uploader: '', webpage: '', videoId: '',
  };
  if (!job.url) throw new Error('缺少视频链接');
  if (signal && signal.aborted) throw new Error('已取消');

  // 工作目录：cfg.media/<safe-id>
  const workId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(cfg.media, workId);
  await fsp.mkdir(dir, { recursive: true });

  try {
    log('解析视频信息…');
    await resolveMeta(job, cfg, deps, signal);
    log(`标题：${job.title}`);
    log(`时长：${fmtSec(job.duration)}${job.uploader ? '　UP 主：' + job.uploader : ''}`);

    log('下载视频（1080p）…');
    const videoPath = await downloadVideo(job, cfg, deps, dir, signal);
    const vst = await fsp.stat(videoPath);
    log(`视频落地：${(vst.size / 1048576).toFixed(1)} MB`);

    log('抽取音轨（16 kHz 单声道）…');
    const wav = await extractWav(job, deps, videoPath, dir, signal);

    log('whisper 转写中…');
    const { txt, srt } = await transcribe(job, cfg, deps, wav, dir, signal);
    log(`转写完成：${txt.length} 字`);

    if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { canceled: true });

    log('生成 Markdown 笔记…');
    const note = await buildNote(job, cfg, llmStream, txt, srt);

    const name = noteFilename(job, cfg.note && cfg.note.prefix);
    const notesDir = cfg.notes || path.join(os.homedir(), 'Desktop', '宋浩高数笔记');
    await fsp.mkdir(notesDir, { recursive: true });
    const full = path.join(notesDir, name);
    await fsp.writeFile(full, note.endsWith('\n') ? note : note + '\n', 'utf8');
    log(`笔记已保存：${full}`);

    let pdfPath = '';
    if (cfg.pdf !== false) {
      const browser = cfg.browserPath || findBrowser();
      if (!browser) {
        log('未找到 Edge/Chrome，跳过 PDF 生成');
      } else {
        log('渲染 PDF…');
        pdfPath = await noteToPdf(note, full, browser, signal);
        log(`PDF 已保存：${pdfPath}`);
      }
    }

    return {
      notePath: full,
      pdfPath,
      noteName: name,
      title: job.title,
      duration: job.duration,
      uploader: job.uploader,
      note,
    };
  } finally {
    // 清理临时视频/音轨/转写，除非 keepVideo
    if (!cfg.keepVideo) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
