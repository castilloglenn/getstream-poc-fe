## Stream Video + OpenAI Realtime — Frontend-only POC

This repo contains a minimal Next.js app (App Router) that:

- Joins a Stream video call right from the browser
- Connects to OpenAI Realtime for a live, talking HR interviewer
- Records a single video file of your camera + mixed audio (mic + assistant)
- Optionally uploads the recording to S3 using a presigned URL (if AWS credentials are configured)

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

# S3 target bucket and AWS credentials (server only, optional for S3 upload)
S3_BUCKET=your-bucket-name
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
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
  - Upload the final `.webm` to S3 via a presigned URL (if AWS credentials are set)

3. Stop and save

- Click “Stop & save” to end everything
- If AWS env vars are configured, the app uploads the recording directly to S3.
  - On any upload error, it falls back to a local `.webm` download so you never lose the file.

## What’s included

- Stream Video React SDK UI (SpeakerLayout + CallControls)
- OpenAI Realtime WebRTC setup (no backend)
- Voice and language controls for the HR interviewer
- Textarea to edit your interview script
- One-click Start/Stop with upload-to-S3 (with local download fallback)

## Notes and limitations

- This demo intentionally uses NEXT*PUBLIC*\* keys in the browser. Never ship this to production.
- Voices are mapped simply (male → ash, female → verse) and can be customized.
- If you want to capture other participants’ audio, you can extend the mixer to include their Stream tracks.
- Tested with modern Chromium-based browsers. Safari/Firefox support may vary for MediaRecorder and Realtime.

## Folder of interest

- `src/app/page.tsx` – the entire PoC lives here
- `src/app/api/upload-url/route.ts` – server route that issues presigned S3 PUT URLs

## Enable direct S3 upload

By default, the app attempts to upload the final recording to S3 using a presigned URL. Add these to `.env.local` to enable server-side presigning:

```bash
# S3 target bucket and AWS credentials (server only)
S3_BUCKET=your-bucket-name
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Make sure your S3 bucket CORS policy allows browser uploads from your site origin (localhost during dev). Example minimal CORS config:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedOrigins": ["http://localhost:3000", "http://127.0.0.1:3000"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Notes:

- The server route only includes ContentType in the signature; the client sets the same header on PUT.
- If you use a different origin (e.g., deployed preview), add it to AllowedOrigins.
- For production, prefer uploading via your own backend rather than exposing credentials.

If S3 upload fails for any reason, the app automatically offers a local `.webm` download instead.

## Troubleshooting

- No audio/voice? Verify browser permissions and that your OpenAI key is correct.
- No call UI? Check Stream API key/secret and that your network allows WebRTC.
- Empty file? Ensure the assistant started speaking (Auto-speak) and your mic/camera were granted.
- S3 upload: If you see "Failed to fetch" on the final PUT, it’s almost always a CORS issue. Verify the bucket CORS above and that your env vars are set. Check logs for `/api/upload-url`.
