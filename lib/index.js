/**
 * dsh-video-notes 插件入口
 * 注册 agent 工具 video_to_notes：下载 B 站视频 → whisper 转写 → DSH 自身 LLM 生成 Markdown 笔记 → 落盘。
 */
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { ensureTools, dataDir } from './deps.js';
import { runVideoToNotes, noteToPdf, findBrowser } from './pipeline.js';

export const name = 'dsh-video-notes';

export const Config = z.object({
  notesDir: z.string()
    .default(path.join(os.homedir(), 'Desktop', '宋浩高数笔记'))
    .description('笔记保存目录')
    .volatile(),
  mediaDir: z.string()
    .default(path.join(os.homedir(), '.dsh', 'video-notes', 'media'))
    .description('视频下载的临时工作目录')
    .volatile(),
  dataDir: z.string()
    .default(path.join(os.homedir(), '.dsh', 'video-notes'))
    .description('转写依赖（whisper/模型/yt-dlp/ffmpeg）下载目录')
    .volatile(),
  notePrefix: z.string()
    .default('宋浩')
    .description('笔记文件名前缀（课程名占位）')
    .volatile(),
  language: z.string()
    .default('zh')
    .description('转写语言')
    .volatile(),
  threads: z.number()
    .default(Math.max(4, (os.cpus().length || 8) - 4))
    .description('whisper 转写线程数')
    .volatile(),
  keepVideo: z.boolean()
    .default(false)
    .description('是否保留下载的视频与音轨')
    .volatile(),
  provider: z.string()
    .default('deepseek-official')
    .description('笔记生成用的 LLM provider')
    .volatile(),
  model: z.string()
    .default('deepseek-flash')
    .description('笔记生成用的模型')
    .volatile(),
  temperature: z.number()
    .default(0.3)
    .description('生成温度')
    .volatile(),
  pdf: z.boolean()
    .default(true)
    .description('是否同时生成 PDF（用 Edge/Chrome 无头渲染）')
    .volatile(),
  browserPath: z.string().default('').description('Edge/Chrome 可执行文件显式路径（留空自动检测）').volatile(),
  ytdlpPath: z.string().default('').description('yt-dlp 显式路径（留空自动检测）').volatile(),
  ffmpegPath: z.string().default('').description('ffmpeg 显式路径（留空自动检测）').volatile(),
  whisperPath: z.string().default('').description('whisper-cli 显式路径（留空自动检测）').volatile(),
  modelPath: z.string().default('').description('whisper 模型显式路径（留空自动检测）').volatile(),
});

/** 解包 Volatile 引用为最新值 */
function resolveConfig(config) {
  const out = {};
  for (const [key, value] of Object.entries(config || {})) {
    out[key] = value && typeof value.get === 'function' ? value.get() : value;
  }
  return out;
}

export function apply(ctx, config) {
  ctx.inject(['tools', 'llm'], (sctx) => {
    sctx.effect(() => {
      const disposers = [];

      disposers.push(sctx.tools.register(
        defineTool({
          name: 'video_to_notes',
          description:
            '下载一个 B 站视频，用本地 whisper 语音转写，再用 DSH 自己的大模型把转写稿整理成一篇结构化的中文 Markdown 学习笔记并保存到本地。' +
            '适合把教学/课程视频（如高数、考研课）转成可复习的笔记。' +
            '过程较长（下载+转写+生成，通常数分钟），期间不返回中间结果。',
          parameters: {
            url: {
              type: 'string',
              required: true,
              description: 'B 站视频链接（支持合集分 P，如 https://www.bilibili.com/video/BVxxxx/?p=3）。',
            },
            notesDir: {
              type: 'string',
              description: '可选：笔记保存目录，覆盖默认目录。',
            },
            language: {
              type: 'string',
              description: '可选：转写语言，默认 zh。',
            },
            pdf: {
              type: 'boolean',
              description: '可选：是否同时生成 PDF（默认按设置，true 强制生成、false 跳过）。',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                notePath: { type: 'string', description: '笔记文件的绝对路径' },
                pdfPath: { type: 'string', description: 'PDF 文件的绝对路径（未生成则为空字符串）' },
                noteName: { type: 'string', description: '笔记文件名' },
                title: { type: 'string', description: '视频标题' },
                duration: { type: 'number', description: '视频时长（秒）' },
                uploader: { type: 'string', description: 'UP 主' },
                note: { type: 'string', description: '生成的 Markdown 笔记全文' },
              },
            },
            render(_args, value) {
              return [{ type: 'text', text: value.note }];
            },
          },
          async execute(args, exec) {
            const cfg = resolveConfig(config);
            if (args.notesDir) cfg.notesDir = args.notesDir;
            if (args.language) cfg.language = args.language;
            if (args.pdf != null) cfg.pdf = args.pdf;
            if (!cfg.mediaDir || !cfg.mediaDir.trim()) {
              cfg.mediaDir = path.join(os.homedir(), '.dsh', 'video-notes', 'media');
            }
            if (!cfg.notesDir || !cfg.notesDir.trim()) {
              cfg.notesDir = path.join(os.homedir(), 'Desktop', '宋浩高数笔记');
            }
            cfg.media = cfg.mediaDir;
            cfg.notes = cfg.notesDir;
            cfg.note = { prefix: cfg.notePrefix || '' };

            const log = (line) => { if (line) console.log('[video_to_notes]', line); };

            const deps = await ensureTools(cfg, log);
            const result = await runVideoToNotes({
              url: args.url,
              cfg,
              deps,
              llmStream: (opts) => sctx.llm.stream(opts),
              signal: exec.signal,
              log,
            });
            return result;
          },
        })
      ));

      // 第二个工具：把已有 markdown 笔记转成 PDF
      disposers.push(sctx.tools.register(
        defineTool({
          name: 'note_to_pdf',
          description:
            '把一篇本地的 Markdown 笔记文件渲染成 PDF（用 Edge/Chrome 无头打印）。' +
            '输入 markdown 文件的绝对路径，输出同目录同名的 .pdf。',
          parameters: {
            mdPath: {
              type: 'string',
              required: true,
              description: 'Markdown 笔记文件的绝对路径（如 C:\\Users\\...\\笔记.md）。',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pdfPath: { type: 'string', description: '生成的 PDF 绝对路径' },
              },
            },
            render(_args, value) {
              return [{ type: 'text', text: `PDF 已生成：${value.pdfPath}` }];
            },
          },
          async execute(args) {
            const cfg = resolveConfig(config);
            const browser = cfg.browserPath || findBrowser();
            if (!browser) throw new Error('未找到 Edge/Chrome 浏览器，无法生成 PDF');
            const mdPath = String(args.mdPath || '').trim();
            if (!mdPath || !/\.md$/i.test(mdPath)) throw new Error('请提供 .md 文件路径');
            const fs = await import('node:fs/promises');
            const note = await fs.readFile(mdPath, 'utf8');
            const pdfPath = await noteToPdf(note, mdPath, browser, undefined);
            return { pdfPath };
          },
        })
      ));

      return () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
    }, 'dsh-video-notes: tools');
  });
}

export { dataDir };
