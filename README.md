## Stream Video + OpenAI Realtime — Frontend-only POC

This repo contains a minimal Next.js app (App Router) that:

- Joins a Stream video call right from the browser
- Connects to OpenAI Realtime for a live, talking HR interviewer
- Records a single video file of your camera + mixed audio (mic + assistant)

Everything runs in the browser only for quick testing. Do not use this setup in production.

## Quick start (pnpm)

1. Install deps

```bash
pnpm install
```

2. Create `.env.local` (frontend-only, insecure for POC)

```bash
# Stream (POC: exposes secret to client)
NEXT_PUBLIC_STREAM_API_KEY=your_stream_api_key
NEXT_PUBLIC_STREAM_API_SECRET=your_stream_api_secret

# OpenAI (POC: exposes key to client)
NEXT_PUBLIC_OPENAI_API_KEY=sk-...
```

3. Run the dev server

```bash
pnpm dev
```

Open http://localhost:3000

## How to use the PoC

The UI is a single page in `src/app/page.tsx`.

1. Configuration

- Ensure your Stream and OpenAI keys are filled
- Choose voice gender (Male/Female)
- Choose language (English/Japanese)
- Paste your interview questions (one per line)

2. Start session

- Click “Start session”
- The app will ask for mic/camera permissions
- It will:
  - Start OpenAI Realtime with your voice + language settings
  - Join a Stream call and show a minimal call UI
  - Begin recording one WebM video: camera video + mixed audio

3. Stop and save

- Click “Stop & save” to end everything
- A `.webm` file is downloaded automatically

## What’s included

- Stream Video React SDK UI (SpeakerLayout + CallControls)
- OpenAI Realtime WebRTC setup (no backend)
- Voice and language controls for the HR interviewer
- Textarea to edit your interview script
- One-click Start/Stop with auto-download recording

## Notes and limitations

- This demo intentionally uses NEXT*PUBLIC*\* keys in the browser. Never ship this to production.
- Voices are mapped simply (male → ash, female → verse) and can be customized.
- If you want to capture other participants’ audio, you can extend the mixer to include their Stream tracks.
- Tested with modern Chromium-based browsers. Safari/Firefox support may vary for MediaRecorder and Realtime.

## Folder of interest

- `src/app/page.tsx` – the entire PoC lives here

## Troubleshooting

- No audio/voice? Verify browser permissions and that your OpenAI key is correct.
- No call UI? Check Stream API key/secret and that your network allows WebRTC.
- Empty download? Ensure the assistant started speaking (Auto-speak) and your mic/camera were granted.
