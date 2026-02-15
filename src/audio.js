import { spawn } from 'node:child_process';

function getFfmpegCmd() {
  return process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()
    ? process.env.FFMPEG_PATH.trim()
    : 'ffmpeg';
}
export async function* mp3ToPcm8k16MonoChunks(filePath) {
  const ffmpeg = getFfmpegCmd();

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', '8000',
    'pipe:1'
  ];

  const ff = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let spawnError = null;
  ff.on('error', (err) => {
    spawnError = err;
    try { ff.stdout?.destroy(err); } catch {}
    try { ff.stderr?.destroy(err); } catch {}
  });

  let buffer = Buffer.alloc(0);
  const CHUNK_BYTES = 640;

  const stderrChunks = [];
  ff.stderr.on('data', (d) => stderrChunks.push(d));

  if (ff.stdout) {
    for await (const data of ff.stdout) {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= CHUNK_BYTES) {
        const chunk = buffer.subarray(0, CHUNK_BYTES);
        buffer = buffer.subarray(CHUNK_BYTES);
        yield chunk;
      }
    }
  }

  if (spawnError) {
    if (spawnError.code === 'ENOENT') {
      throw new Error(
        `ffmpeg not found. Install ffmpeg or set FFMPEG_PATH in .env. Tried to run: ${ffmpeg}`
      );
    }
    throw spawnError;
  }

  const code = await new Promise((res) => ff.on('close', res));
  if (code !== 0) {
    const msg = Buffer.concat(stderrChunks).toString('utf8');
    throw new Error(`ffmpeg failed (code=${code}): ${msg}`);
  }
}
