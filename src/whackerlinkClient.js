import WebSocket from 'ws';
import crypto from 'node:crypto';

const PacketType = {
  AUDIO_DATA: 0x01,
  GRP_AFF_REQ: 0x02,
  GRP_VCH_REQ: 0x05,
  GRP_VCH_RLS: 0x06,
  GRP_VCH_RSP: 0x07,
  U_REG_REQ: 0x08,
};

const AudioMode = {
  PCM_8_16: 0x00,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashAuthKey(key) {
  return crypto
    .createHash('sha256')
    .update(String(key ?? '').trim(), 'utf8')
    .digest('base64');
}

function normalizeVoiceChannels(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildSite({ name, controlChannel, voiceChannels, siteId, systemId, location, range }) {
  return {
    Name: String(name ?? 'BridgeSite'),
    ControlChannel: String(controlChannel ?? ''),
    VoiceChannels: normalizeVoiceChannels(voiceChannels),
    Location: location ?? { X: '0', Y: '0', Z: '0' },
    SiteID: String(siteId ?? '1'),
    SystemID: String(systemId ?? ''),
    Range: Number(range ?? 0),
  };
}

export class WhackerLinkClient {
  constructor({ host, port, authKey, srcId, sysId, talkgroup, siteConfig }) {
    this.host = host;
    this.port = port;
    this.authKey = String(authKey ?? '').trim();

    this.srcId = String(srcId);
    this.sysId = String(sysId);
    this.talkgroup = String(talkgroup);

    this.site = buildSite({
      name: siteConfig?.name,
      controlChannel: siteConfig?.controlChannel,
      voiceChannels: siteConfig?.voiceChannels,
      siteId: siteConfig?.siteId,
      systemId: this.sysId,

      location: siteConfig?.location,
      range: siteConfig?.range,
    });

    this.ws = null;
    this.voiceChannel = null;

    this.debug = false; 

  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    let url = `ws://${this.host}:${this.port}/client`;

    if (this.authKey) {
      const hashed = hashAuthKey(this.authKey);
      url = `ws://${this.host}:${this.port}/client?authKey=${encodeURIComponent(hashed)}`;
    }

    this.ws = new WebSocket(url);

    this.ws.on('message', (data) => this.#onMessage(data));
    this.ws.on('close', (c, r) => console.log(`[WL] closed ${c} ${r}`));
    this.ws.on('error', (e) => console.error('[WL] error', e));

    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    await sleep(150);
  }

  #send(type, data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WhackerLink not connected');
    }
    this.ws.send(JSON.stringify({ type, data }));
  }

  #onMessage(raw) {
    const text = raw.toString('utf8');
    if (this.debug) console.log('[WL <=]', text);

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    const type = Number(msg.type);
    const data = msg.data;

    if (type === PacketType.GRP_VCH_RSP) {
      const channel = data?.Channel ?? data?.channel ?? '';
      const status = data?.Status ?? data?.status;

      if (this.debug) console.log('[WL] GRP_VCH_RSP status=', status, 'channel=', channel);

      this.voiceChannel = {
        SrcId: this.srcId,
        DstId: this.talkgroup,
        Frequency: String(channel),
        ClientId: this.srcId,
        IsActive: true,
        Site: this.site,
      };
    }
  }

  async ensureRegisteredAndAffiliated() {
    await this.connect();

    if (!this.site?.ControlChannel) {
      throw new Error(
        'Site.ControlChannel is empty. Set WL_CONTROL_CHANNEL and WL_VOICE_CHANNELS in your .env from wl_v4 config.'
      );
    }
    if (!this.site?.VoiceChannels?.length) {
      throw new Error(
        'Site.VoiceChannels is empty. Set WL_VOICE_CHANNELS in your .env from wl_v4 config.'
      );
    }

    this.#send(PacketType.U_REG_REQ, {
      SrcId: this.srcId,
      SysId: this.sysId,
      Wacn: '0',
      Site: this.site,
    });

    this.#send(PacketType.GRP_AFF_REQ, {
      SrcId: this.srcId,
      DstId: this.talkgroup,
      SysId: this.sysId,
      Site: this.site,
    });

    await sleep(150);
  }

  async requestVoiceChannel() {
  this.voiceChannel = null;

  this.#send(PacketType.GRP_VCH_REQ, {
    SrcId: this.srcId,
    DstId: this.talkgroup,
    Site: this.site,
  });

  for (let i = 0; i < 40 && !this.voiceChannel; i++) await sleep(100);

  const channel = this.voiceChannel?.Frequency;
  if (!channel) {
    throw new Error(
      'Did not receive GRP_VCH_RSP (no channel granted).'
    );
  }

  return channel; 

}

  async releaseVoiceChannel(channel) {
  const ch = String(channel ?? '').trim();
  if (!ch) {
    console.log('[TX] releaseVoiceChannel called with empty channel; skipping');
    return;
  }

  console.log('[TX] sending GRP_VCH_RLS', ch);

  this.#send(PacketType.GRP_VCH_RLS, {
    SrcId: this.srcId,
    DstId: this.talkgroup,
    Channel: ch,
    Site: this.site,
  });

  this.voiceChannel = null;
}

async transmitPcmChunks(pcmChunkAsyncIterable) {
  await this.ensureRegisteredAndAffiliated();

  const grantedChannel = await this.requestVoiceChannel();

  const vch = {
    SrcId: this.srcId,
    DstId: this.talkgroup,
    Frequency: grantedChannel,
    ClientId: this.srcId,
    IsActive: true,
    Site: this.site,
  };

  const watchdogMs = 60000;
  let watchdog = null;
  let aborted = false;

  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      aborted = true;
      console.log('[TX] watchdog abort + release');
      this.releaseVoiceChannel(grantedChannel).catch(() => {});
    }, watchdogMs);
  };

  armWatchdog();

  try {
    for await (const chunk of pcmChunkAsyncIterable) {
      if (aborted) break;

      // backpressure guard
      while (this.ws.bufferedAmount > 2 * 1024 * 1024) {
        await sleep(5);
      }

      this.#send(PacketType.AUDIO_DATA, {
        LopServerVocode: true,
        Data: chunk.toString('base64'),
        VoiceChannel: vch,
        AudioMode: AudioMode.PCM_8_16,
        Site: this.site,
      });

      armWatchdog();
      await sleep(40);
    }

    await sleep(200);
  } finally {
    clearTimeout(watchdog);
    console.log('[TX] final release');
    await this.releaseVoiceChannel(grantedChannel).catch(() => {});
    console.log('[TX] done');
  }
}
}

