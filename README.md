# jm-sdrtrunk-wl-bridge

This project is a small Node.js service that acts as a bridge between SDRTrunk and WhackerLink or WhackerLink-compatible services.
It receives data from SDRTrunk over HTTP and forwards or adapts it so it can be consumed by downstream systems.

The goal is to integrate SDRTrunk output into other tools without modifying SDRTrunk itself.

## What it does

- Runs a lightweight HTTP server
- Accepts incoming requests from SDRTrunk
- Processes and forwards the data in a compatible format
- Handles file uploads safely and logs requests for debugging

## Requirements

- Node.js 18 or newer
- npm

## Setup

1. Clone the repository or download the project.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the server:

   ```bash
   npm start
   ```

The server will start listening on the configured port and is ready to receive requests from SDRTrunk.

## Formatting

This project uses Prettier for consistent formatting:

```bash
npm run format
```

## Notes

- The uploads directory is created automatically if needed.
- SDRTrunk is not modified; this service runs alongside it.
