import 'dotenv/config';

export const config = {
  httpPort: Number(process.env.PORT ?? 4010),

  wl: {
    host: process.env.WL_HOST ?? '127.0.0.1',
    port: Number(process.env.WL_PORT ?? 3000),
    authKey: process.env.WL_AUTH_KEY ?? '',
    srcId: String(process.env.WL_SRC_ID ?? '3500025'),
    sysId: String(process.env.WL_SYS_ID ?? '1'),
    talkgroup: String(process.env.WL_TALK_GROUP ?? '1501'),
  },

  ingestKey: process.env.BRIDGE_INGEST_KEY ?? '',
};
