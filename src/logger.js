import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export const log = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
            singleLine: false,
          },
        },
      }),
});
