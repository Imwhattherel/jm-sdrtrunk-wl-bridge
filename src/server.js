import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { log } from './logger.js';

import { config } from './config.js';
import { TxQueue } from './txQueue.js';
import { WhackerLinkClient } from './whackerlinkClient.js';
import { mp3ToPcm8k16MonoChunks } from './audio.js';

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function reqId() {
  return crypto.randomUUID?.() ?? String(Date.now());
}

function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  for (const k of ['key', 'apiKey', 'apikey', 'APIKEY', 'authKey', 'authkey']) {
    if (k in copy) copy[k] = '***';
  }
  return copy;
}

app.use((req, res, next) => {
  req._rid = reqId();
  const start = process.hrtime.bigint();

  log.info(
    { tag: 'HTTP', rid: req._rid, method: req.method, url: req.url },
    'request'
  );

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const lvl =
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    log[lvl](
      {
        tag: 'HTTP',
        rid: req._rid,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        ms: Math.round(ms),
      },
      'response'
    );
  });

  next();
});

app.use((req, res, next) => {
  const oldSend = res.send.bind(res);
  res.send = (body) => {
    let preview = body;
    if (typeof body === 'object') preview = JSON.stringify(body);
    preview = String(preview);
    if (preview.length > 500) preview = preview.slice(0, 500) + '…';

    log.debug(
      { tag: 'HTTP', rid: req._rid, status: res.statusCode, body: preview },
      'body'
    );
    return oldSend(body);
  };
  next();
});

function parseFreqMap(str) {
  const map = new Map();
  if (!str) return map;

  for (const pair of String(str).split(',')) {
    const p = pair.trim();
    if (!p) continue;
    const [freqStr, tgStr] = p.split(':').map((s) => s.trim());
    const mhz = Number(freqStr);
    const tg = String(tgStr ?? '').trim();
    if (!Number.isFinite(mhz) || !tg) continue;
    map.set(mhz, tg);
  }
  return map;
}

function hzToMhzNumber(hz) {
  const n = Number(hz);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1_000_000) return n / 1_000_000;
  return n;
}

function roundToKHz(mhz) {
  return Math.round(mhz * 1000) / 1000;
}

function pickFrequencyMhz(reqBody) {
  const f = reqBody?.frequency ?? reqBody?.freq ?? reqBody?.Frequency;
  const mhz = hzToMhzNumber(f);
  if (mhz) return mhz;

  const freqsRaw = reqBody?.frequencies;
  if (!freqsRaw) return null;

  try {
    const arr = typeof freqsRaw === 'string' ? JSON.parse(freqsRaw) : freqsRaw;
    if (Array.isArray(arr) && arr.length) {
      const first = arr[0];
      const mhz2 = hzToMhzNumber(first?.freq ?? first?.Freq ?? first);
      if (mhz2) return mhz2;
    }
  } catch {
  }

  return null;
}

function mapFreqToTalkgroup(freqMhz, freqMap, toleranceKhz, defaultTg) {
  if (!freqMhz || !Number.isFinite(freqMhz)) return defaultTg;

  const rounded = roundToKHz(freqMhz);
  if (freqMap.has(rounded)) return freqMap.get(rounded);

  const tolMhz = (Number(toleranceKhz) || 0) / 1000;
  for (const [mhzKey, tg] of freqMap.entries()) {
    if (Math.abs(mhzKey - rounded) <= tolMhz) return tg;
  }

  return defaultTg;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads',
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});

const txQueue = new TxQueue();

const wl = new WhackerLinkClient({
  host: config.wl.host,
  port: config.wl.port,
  authKey: config.wl.authKey,
  srcId: config.wl.srcId,
  sysId: config.wl.sysId,
  talkgroup: config.wl.talkgroup, // this is now just initial/default
  siteConfig: {
    name: process.env.WL_SITE_NAME,
    siteId: process.env.WL_SITE_ID,
    controlChannel: process.env.WL_CONTROL_CHANNEL,
    voiceChannels: process.env.WL_VOICE_CHANNELS,
  },
});

app.post('/api/call-upload', upload.any(), async (req, res) => {
  try {
    const bodyTest = String(req.body?.test ?? '').trim();
    const isTest = bodyTest === '1';

    log.debug(
      { tag: 'HTTP', rid: req._rid, body: redactBody(req.body) },
      'parsed body'
    );

    if (config.ingestKey) {
      const providedKey =
        String(req.body?.key ?? '') ||
        String(req.body?.apiKey ?? '') ||
        String(req.body?.apikey ?? '') ||
        String(req.body?.APIKEY ?? '') ||
        String(req.body?.authKey ?? '') ||
        String(req.body?.authkey ?? '');

      if (String(providedKey) !== String(config.ingestKey)) {
        log.warn({ tag: 'AUTH', rid: req._rid }, 'invalid key');
        return res.status(401).type('text/plain').send('Invalid key');
      }
    }

    if (isTest) {
      log.info({ tag: 'TEST', rid: req._rid }, 'test upload received');
      return res
        .status(200)
        .type('text/plain')
        .send('Incomplete call data: no talkgroup');
    }

    const file = Array.isArray(req.files) ? req.files[0] : undefined;

    log.info(
      {
        tag: 'HTTP',
        rid: req._rid,
        field: file?.fieldname,
        name: file?.originalname,
        type: file?.mimetype,
        size: file?.size,
      },
      'file uploaded'
    );

    if (!file?.path) {
      log.warn({ tag: 'HTTP', rid: req._rid }, 'missing audio file');
      return res.status(400).type('text/plain').send('Missing audio file');
    }

    const sysId = String(
      req.body?.system ?? req.body?.systemId ?? req.body?.sysId ?? config.wl.sysId
    );

    // ────────────────────────────────────────────────────────────────
    // MAIN CHANGE: Pull talkgroup from request first (SDRTrunk/Rdio style)
    // ────────────────────────────────────────────────────────────────
    let talkgroup = req.body?.talkgroup ?? req.body?.Talkgroup ?? req.body?.tg ?? null;

    if (talkgroup != null) {
      talkgroup = String(talkgroup).trim();
      if (!/^\d+$/.test(talkgroup)) {
        talkgroup = null; // invalid format → fallback
      }
    }

    let resolutionMethod = 'request';

    if (!talkgroup) {
      // Fallback 1: frequency-based mapping
      const freqMap = parseFreqMap(process.env.FREQ_MAP);
      const defaultTg = String(process.env.FREQ_MAP_DEFAULT_TG ?? config.wl.talkgroup);
      const toleranceKhz = Number(process.env.FREQ_MAP_TOLERANCE_KHZ ?? 3);

      const freqMhz = pickFrequencyMhz(req.body);
      talkgroup = mapFreqToTalkgroup(freqMhz, freqMap, toleranceKhz, defaultTg);

      if (talkgroup !== defaultTg) {
        resolutionMethod = 'frequency_map';
      } else {
        resolutionMethod = 'default_fallback';
      }
    }

    // Final safety net (should be rare)
    if (!talkgroup) {
      talkgroup = config.wl.talkgroup;
      resolutionMethod = 'config_default';
      log.warn({ tag: 'MAP', rid: req._rid }, 'No talkgroup resolved → using static config default');
    }

    log.info(
      {
        tag: 'MAP',
        rid: req._rid,
        freqRaw: req.body?.frequency ?? req.body?.freq,
        freqMhz: pickFrequencyMhz(req.body),
        talkgroup,
        sysId,
        resolution: resolutionMethod,
      },
      'talkgroup resolved'
    );

    const audioPath = file.path;

    txQueue.enqueue(async () => {
      log.info(
        { tag: 'TX', rid: req._rid, audioPath, sysId, talkgroup },
        'starting'
      );

      wl.sysId = sysId;
      wl.talkgroup = talkgroup;

      try {
        const pcmChunks = [];
        for await (const c of mp3ToPcm8k16MonoChunks(audioPath)) {
          pcmChunks.push(c);
        }

        await wl.transmitPcmChunks(pcmChunks);
        log.info({ tag: 'TX', rid: req._rid }, 'transmit returned');
      } catch (e) {
        log.error({ tag: 'TX', rid: req._rid, err: e }, 'failed');
      } finally {
        await fs.unlink(audioPath).catch((e) => {
          log.warn({ tag: 'FS', rid: req._rid, err: e, audioPath }, 'unlink failed');
        });
      }
    });

    log.info({ tag: 'TX', rid: req._rid }, 'queued');
    return res.status(200).type('text/plain').send('Queued');
  } catch (e) {
    log.error({ tag: 'HTTP', rid: req._rid, err: e }, 'ingest error');
    return res.status(500).type('text/plain').send('Server error');
  }
});

app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/api/call-upload', (req, res) => res.status(200).type('text/plain').send('OK'));
app.get('/health', (_, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  log.error({ tag: 'HTTP', rid: req?._rid, err }, 'error middleware');
  res.status(500).send('Server error');
});

app.listen(config.httpPort, () => {
  log.info(
    { tag: 'BOOT', port: config.httpPort },
    `Bridge listening on :${config.httpPort}`
  );
  log.info(
    { tag: 'BOOT', url: `http://127.0.0.1:${config.httpPort}/api/call-upload` },
    'POST endpoint'
  );
  log.info(
    { tag: 'BOOT', url: `ws://${config.wl.host}:${config.wl.port}/client` },
    'WhackerLink websocket'
  );
});
