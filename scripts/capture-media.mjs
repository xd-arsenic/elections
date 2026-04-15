#!/usr/bin/env node
/**
 * 1) PNG screenshots of slide1–5 at slide size (1080×1350) × deviceScaleFactor (default 2).
 * 2) index.html: mobile 9:16 viewport → one screenshot per scroll position (no Playwright WebM)
 *    → ffmpeg H.264 MP4 (index-scroll.mp4). This avoids WebM’s low bitrate ceiling.
 *
 * Usage:
 *   npm install
 *   npx playwright install chromium
 *   npm run capture
 *
 * Env (optional):
 *   SLIDE_DPR=2
 *   INTRO_MS=3400     — top-of-page hold (match main.js hold+count ≈ 1040+2080 + margin)
 *   SCROLL_MS=37500   — scroll segment (~2× faster than old 75s default)
 *   SCROLL_EASE=linear — linear (constant speed) or easeinout (slow at both ends)
 *   VIDEO_WIDTH=480   VIDEO_HEIGHT=852   VIDEO_DPR=3  (height may −1 so width×DPR & height×DPR are even for H.264)
 *   SCROLL_FPS=24     — output fps (intro uses same; spacing = 1000/fps ms for counter time)
 *   FRAME_FORMAT=jpeg — jpeg | png (png is lossless but huge / slow)
 *   JPEG_QUALITY=98   — when FRAME_FORMAT=jpeg (1–100)
 *   FFMPEG_CRF=14     — x264 final pass (lower = better; 12–16 typical from frames)
 *   FFMPEG_PRESET=slow
 *   FFMPEG_PATH=…
 *   SLIDES_ONLY=1     — only export slide1–5 PNGs (skip index video)
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'capture-output');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
};

function createStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        let pathname = decodeURIComponent(u.pathname);
        if (pathname === '/') pathname = '/index.html';
        const filePath = path.normalize(path.join(root, pathname));
        if (!filePath.startsWith(path.normalize(root + path.sep))) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.end(data);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(500);
          res.end(e instanceof Error ? e.message : String(e));
        }
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

const SLIDE_W = 1080;
const SLIDE_H = 1350;
const slideDpr = Math.max(1, Math.min(3, Number(process.env.SLIDE_DPR) || 2));
const introMs = Math.max(0, Number(process.env.INTRO_MS) || 3400);
const scrollMs = Math.max(5000, Number(process.env.SCROLL_MS) || 37500);
const DEFAULT_VIDEO_W = 480;
const DEFAULT_VIDEO_H = Math.round((DEFAULT_VIDEO_W * 16) / 9);
let videoW = Math.max(200, Number(process.env.VIDEO_WIDTH) || DEFAULT_VIDEO_W);
let videoH = Math.max(200, Number(process.env.VIDEO_HEIGHT) || DEFAULT_VIDEO_H);
const videoDpr = Math.max(1, Math.min(3, Number(process.env.VIDEO_DPR) || 3));
/** yuv420p / libx264 need even width & height in *device* pixels */
while (Math.round(videoH * videoDpr) % 2 !== 0) videoH -= 1;
while (Math.round(videoW * videoDpr) % 2 !== 0) videoW -= 1;
const scrollFps = Math.max(12, Math.min(60, Number(process.env.SCROLL_FPS) || 24));
const frameFormat = (process.env.FRAME_FORMAT || 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpeg';
const jpegQuality = Math.max(1, Math.min(100, Number(process.env.JPEG_QUALITY) || 98));

function resolveFfmpegBin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (ffmpegStatic) return ffmpegStatic;
  return 'ffmpeg';
}

async function assertFfmpeg() {
  const ffmpeg = resolveFfmpegBin();
  await execFileAsync(ffmpeg, ['-hide_banner', '-version'], { stdio: 'ignore' }).catch(() => {
    throw new Error(
      'ffmpeg not found. Run: npm install (ffmpeg-static) or brew install ffmpeg and set FFMPEG_PATH'
    );
  });
  return ffmpeg;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Constant scroll speed in the output (ease-in-out is slow at top and bottom). */
function scrollEasing(t) {
  const mode = (process.env.SCROLL_EASE || 'linear').toLowerCase();
  if (mode === 'easeinout' || mode === 'ease-in-out') return easeInOutCubic(t);
  return t;
}

async function waitSingleRaf(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

async function waitDoubleRaf(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function scrollToTop(page) {
  await page.evaluate(() => {
    document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
    if (document.body) document.body.style.setProperty('scroll-behavior', 'auto', 'important');
    const root = document.scrollingElement || document.documentElement;
    window.scrollTo(0, 0);
    root.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  });
}

async function removeOrphanPlaywrightWebms() {
  const entries = await fs.readdir(OUT).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => name.startsWith('page@') && name.endsWith('.webm'))
      .map((name) => fs.unlink(path.join(OUT, name)).catch(() => {}))
  );
}

/**
 * Stays at scroll 0 with real-time spacing so hero [data-count] animation is visible (~INTRO_MS).
 */
async function captureIntroFramesAtTop(page, framesDir, introFrames, fps) {
  if (introFrames < 1) return;
  const ext = frameFormat === 'png' ? 'png' : 'jpg';
  const gapMs = 1000 / fps;
  for (let i = 0; i < introFrames; i++) {
    await page.evaluate(() => {
      document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
      if (document.body) document.body.style.setProperty('scroll-behavior', 'auto', 'important');
      window.scrollTo(0, 0);
    });
    // First frame ASAP so counters still read 0 (avoid long waits before intro was starting mid-animation).
    if (i === 0) await waitSingleRaf(page);
    else await waitDoubleRaf(page);
    const name = `${String(i + 1).padStart(5, '0')}.${ext}`;
    const shotPath = path.join(framesDir, name);
    if (frameFormat === 'png') {
      await page.screenshot({ path: shotPath, type: 'png' });
    } else {
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: jpegQuality });
    }
    if (i < introFrames - 1) await sleep(gapMs);
    if ((i + 1) % 24 === 0 || i === 0) {
      process.stdout.write(`\r  intro ${i + 1}/${introFrames}`);
    }
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
}

/**
 * Scroll positions; filenames start at startFrameIndex (1-based, after intro stills).
 */
async function captureScrollFrameStills(page, framesDir, maxScroll, scrollFrames, startFrameIndex) {
  const ext = frameFormat === 'png' ? 'png' : 'jpg';
  for (let i = 0; i < scrollFrames; i++) {
    const t = scrollFrames <= 1 ? 1 : i / (scrollFrames - 1);
    const y = scrollEasing(t) * maxScroll;
    await page.evaluate(([scrollY]) => {
      document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
      if (document.body) document.body.style.setProperty('scroll-behavior', 'auto', 'important');
      window.scrollTo(0, scrollY);
    }, [y]);
    await waitDoubleRaf(page);
    const frameNum = startFrameIndex + i;
    const name = `${String(frameNum).padStart(5, '0')}.${ext}`;
    const shotPath = path.join(framesDir, name);
    if (frameFormat === 'png') {
      await page.screenshot({ path: shotPath, type: 'png' });
    } else {
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: jpegQuality });
    }
    if ((i + 1) % 30 === 0 || i === 0) {
      process.stdout.write(`\r  scroll ${i + 1}/${scrollFrames}`);
    }
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
}

async function encodeStillsToMp4(framesDir, fps, destMp4) {
  const ffmpeg = await assertFfmpeg();
  const ext = frameFormat === 'png' ? 'png' : 'jpg';
  const inputPattern = path.join(framesDir, `%05d.${ext}`);
  const crf = String(Math.max(10, Math.min(28, Number(process.env.FFMPEG_CRF) || 14)));
  const preset = process.env.FFMPEG_PRESET || 'slow';
  await execFileAsync(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-framerate',
    String(fps),
    '-i',
    inputPattern,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-crf',
    crf,
    '-preset',
    preset,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    destMp4,
  ]);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await removeOrphanPlaywrightWebms();

  const server = await createStaticServer(ROOT);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });

  try {
    const shotPage = await browser.newPage({
      viewport: { width: SLIDE_W, height: SLIDE_H },
      deviceScaleFactor: slideDpr,
    });

    for (let i = 1; i <= 5; i++) {
      const url = `${base}/slide${i}.html`;
      await shotPage.goto(url, { waitUntil: 'load', timeout: 60000 });
      await sleep(1200);
      const outPath = path.join(OUT, `slide${i}.png`);
      await shotPage.screenshot({ path: outPath, type: 'png' });
      console.log('Wrote', path.relative(ROOT, outPath), `(${SLIDE_W * slideDpr}×${SLIDE_H * slideDpr} px PNG @ DPR ${slideDpr})`);
    }

    await shotPage.close();

    if (process.env.SLIDES_ONLY === '1') {
      console.log('\nDone (slides only). Files in ./capture-output/');
      return;
    }

    const introFrames = introMs > 0 ? Math.max(1, Math.round((introMs / 1000) * scrollFps)) : 0;
    const scrollFrames = Math.max(2, Math.round((scrollMs / 1000) * scrollFps));
    const totalFrames = introFrames + scrollFrames;
    const framesDir = path.join(OUT, `scroll-frames-${Date.now()}`);
    await fs.mkdir(framesDir, { recursive: true });

    try {
      const videoContext = await browser.newContext({
        viewport: { width: videoW, height: videoH },
        deviceScaleFactor: videoDpr,
        isMobile: true,
        hasTouch: true,
      });
      const vpage = await videoContext.newPage();
      await vpage.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 60000 });
      await scrollToTop(vpage);
      await waitSingleRaf(vpage);

      const maxScroll = await vpage.evaluate(() => {
        const root = document.scrollingElement || document.documentElement;
        return Math.max(0, root.scrollHeight - window.innerHeight);
      });

      const easeLabel = (process.env.SCROLL_EASE || 'linear').toLowerCase();
      console.log(
        `Capturing ${totalFrames} frames @ ${scrollFps}fps: intro ${introFrames} (~${(introMs / 1000).toFixed(1)}s top, first frame right after load) + scroll ${scrollFrames} (~${(scrollMs / 1000).toFixed(0)}s, ${easeLabel}) — ${frameFormat}${frameFormat === 'jpeg' ? ` q=${jpegQuality}` : ''}, viewport ${videoW}×${videoH}`
      );
      if (introFrames > 0) {
        await captureIntroFramesAtTop(vpage, framesDir, introFrames, scrollFps);
      }
      await captureScrollFrameStills(vpage, framesDir, maxScroll, scrollFrames, introFrames + 1);
      await vpage.close();
      await videoContext.close();

      const mp4Out = path.join(OUT, 'index-scroll.mp4');
      const crfUsed = String(Math.max(10, Math.min(28, Number(process.env.FFMPEG_CRF) || 14)));
      await encodeStillsToMp4(framesDir, scrollFps, mp4Out);

      await fs.unlink(path.join(OUT, 'index-scroll.webm')).catch(() => {});
      await fs.unlink(path.join(OUT, '_scroll-temp.webm')).catch(() => {});
      await removeOrphanPlaywrightWebms();

      console.log(
        'Wrote',
        path.relative(ROOT, mp4Out),
        `(H.264 CRF ${crfUsed}, ${totalFrames}f@${scrollFps}fps, intro ${introFrames}f + scroll ${scrollFrames}f, viewport ${videoW}×${videoH} @${videoDpr}x)`
      );
    } finally {
      await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log('\nDone. Files in ./capture-output/');
}

main().catch((err) => {
  console.error(err);
  console.error('\nIf Chromium is missing, run: npx playwright install chromium');
  process.exit(1);
});
