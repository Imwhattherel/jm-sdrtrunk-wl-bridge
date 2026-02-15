import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';

import {config} from './config.js';
import { TxQueue } from './txQueue.js';
import { WhackerLinkClient } from './whackerlinkClient.js';
import { mp3ToPcm8k16MonoChunks } from './audio.js';

const app = express();

app.use(express.urlencoded({
    extended: true
}));

app.use(express.json());

app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});
app.use((req, res, next) => {
    const oldSend = res.send.bind(res);
    res.send = (body) => {
        console.log(`[HTTP] RESP ${req.method} ${req.url} -> ${res.statusCode}`, JSON.stringify(body));
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
    const [freqStr, tgStr] = p.split(':').map(s => s.trim());
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
    talkgroup: config.wl.talkgroup,
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

        if (config.ingestKey) {
            const providedKey =
                String(req.body?.key ?? '') ||
                String(req.body?.apiKey ?? '') ||
                String(req.body?.apikey ?? '') ||
                String(req.body?.APIKEY ?? '') ||
                String(req.body?.authKey ?? '') ||
                String(req.body?.authkey ?? '');

            if (String(providedKey) !== String(config.ingestKey)) {
                return res.status(401).type('text/plain').send('Invalid key');
            }
        }

        if (isTest) {

            return res.status(200).type('text/plain').send('Incomplete call data: no talkgroup');
        }

        const file = Array.isArray(req.files) ? req.files[0] : undefined;
        console.log('[HTTP] file:', file?.fieldname, file?.originalname, file?.mimetype, file?.size);

        if (!file?.path) {
            return res.status(400).type('text/plain').send('Missing audio file');
        }

        const sysId =
  String(req.body?.system ?? req.body?.systemId ?? req.body?.sysId ?? config.wl.sysId);

const freqMap = parseFreqMap(process.env.FREQ_MAP);
const defaultTg = String(process.env.FREQ_MAP_DEFAULT_TG ?? config.wl.talkgroup);
const toleranceKhz = Number(process.env.FREQ_MAP_TOLERANCE_KHZ ?? 3);

const freqMhz = pickFrequencyMhz(req.body);

const talkgroup = mapFreqToTalkgroup(freqMhz, freqMap, toleranceKhz, defaultTg);

console.log(`[MAP] freqRaw=${req.body?.frequency} freqMhz=${freqMhz} -> tg=${talkgroup}`);


        const audioPath = file.path;

        txQueue.enqueue(async () => {
            console.log(`[TX] starting file=${audioPath} sys=${sysId} tg=${talkgroup}`);

            wl.sysId = sysId;
            wl.talkgroup = talkgroup;

            try {
                const pcmChunks = [];
                for await (const c of mp3ToPcm8k16MonoChunks(audioPath)) {
                    pcmChunks.push(c);
                }

                await wl.transmitPcmChunks(pcmChunks);
                console.log('[TX] transmit function returned');
            } catch (e) {
                console.error('[TX] failed', e);
            } finally {
                await fs.unlink(audioPath).catch(() => {});
            }
        });

        return res.status(200).type('text/plain').send('Queued');
    } catch (e) {
        console.error('ingest error', e);
        return res.status(500).type('text/plain').send('Server error');
    }
});

app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/api/call-upload', (req, res) => res.status(200).type('text/plain').send('OK'));
app.get('/health', (_, res) => res.json({
    ok: true
}));

app.use((err, req, res, next) => {
    console.error('[HTTP] error middleware:', err);
    res.status(500).send('Server error');
});

app.listen(config.httpPort, () => {
    console.log(`Bridge listening on :${config.httpPort}`);
    console.log(`POST http://127.0.0.1:${config.httpPort}/api/call-upload`);
    console.log(`WhackerLink: ws://${config.wl.host}:${config.wl.port}/client`);
});