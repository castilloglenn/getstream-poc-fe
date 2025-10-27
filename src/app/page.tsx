"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StreamVideo, StreamVideoClient } from "@stream-io/video-react-sdk";
import "@stream-io/video-react-sdk/dist/css/styles.css";
import {
  StreamTheme,
  useCallStateHooks,
  StreamCall,
  SpeakerLayout,
  CallControls,
} from "@stream-io/video-react-sdk";
type StreamCallType = unknown; // Avoid extra type deps in POC; SDK provides the instance at runtime

// Minimal, frontend-only POC that:
// 1) Joins a Stream video call using client-side JWT (insecure; POC only)
// 2) Connects to OpenAI Realtime via WebRTC (voice in/out)
// 3) Optionally records local and remote tracks using MediaRecorder

type RealtimeState = "disconnected" | "connecting" | "connected";
type SessionState = "idle" | "starting" | "running" | "stopping";

export default function Home() {
  // ---- ENV (use NEXT_PUBLIC_* for client-side access) ----
  const envStreamApiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY || "";
  const envStreamApiSecret = process.env.NEXT_PUBLIC_STREAM_API_SECRET || ""; // DO NOT use in prod
  const envOpenAIKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY || ""; // DO NOT use in prod

  // ---- Stream Call state ----
  const [apiKey, setApiKey] = useState(envStreamApiKey);
  const [apiSecret, setApiSecret] = useState(envStreamApiSecret);
  const [userId, setUserId] = useState(Math.random().toString(36).slice(2, 36));
  const [userName] = useState("Demo User");
  const [callId, setCallId] = useState(Math.random().toString(36).slice(2, 36));
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<StreamCallType | null>(null);
  // kept for possible UI feedback in future; not currently used
  // const [joining, setJoining] = useState(false);
  const localAVRef = useRef<MediaStream | null>(null);

  // ---- OpenAI Realtime state ----
  const [openAIKey, setOpenAIKey] = useState(envOpenAIKey);
  const [rtState, setRtState] = useState<RealtimeState>("disconnected");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [voiceGender, setVoiceGender] = useState<"male" | "female">("male");
  const [language, setLanguage] = useState<"english" | "japanese">("english");
  // Reply timing controls
  const [replyDelayMode, setReplyDelayMode] = useState<"fixed" | "random">(
    "fixed"
  );
  const [replyFixedSec, setReplyFixedSec] = useState<number>(3);
  const [replyRandMinSec, setReplyRandMinSec] = useState<number>(3);
  const [replyRandMaxSec, setReplyRandMaxSec] = useState<number>(10);
  const [questions, setQuestions] = useState(
    [
      "We’re testing this voice and captions feature—how does my audio sound?",
      "What are you working on right now?",
      "Share one quick productivity tip you like.",
      "Would you like me to summarize what you just said?",
    ].join("\n")
  );
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // ---- Recording state ----
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const mixedRecorderRef = useRef<MediaRecorder | null>(null);

  // ---- Live captions (Whisper) ----
  type CaptionItem = {
    id: string;
    speaker: "You" | "AI";
    text: string;
    ts: number; // epoch ms
  };
  const [captions, setCaptions] = useState<CaptionItem[]>([]);
  const [transcriptText, setTranscriptText] = useState<string>("");
  const userCaptionRecRef = useRef<MediaRecorder | null>(null);
  const aiCaptionRecRef = useRef<MediaRecorder | null>(null);
  const userUploadBusyRef = useRef(false);
  const aiUploadBusyRef = useRef(false);
  const userCaptionActiveRef = useRef(false);
  const aiCaptionActiveRef = useRef(false);
  const userVADCleanupRef = useRef<null | (() => void)>(null);
  const aiVADCleanupRef = useRef<null | (() => void)>(null);
  const [showCaptions, setShowCaptions] = useState(true);
  const captionsContainerRef = useRef<HTMLDivElement | null>(null);
  const languageCode = useMemo(
    () => (language === "japanese" ? "ja" : "en"),
    [language]
  );

  // ---- Script reading (teleprompter) ----
  const [scriptText, setScriptText] = useState<string>(
    [
      "Test Assistant: Hi there! We’re testing voice and live captions—when you’re ready, start reading this script.",
      "You: Hey! I’m just running a quick test of the audio and transcription features.",
      "Test Assistant: Great. How does the audio sound on your side?",
      "You: It sounds clear enough for a demo in the office.",
      "Test Assistant: Awesome. What are you working on right now?",
      "You: I’m currently testing the live captions and making sure the UI updates smoothly.",
      "Test Assistant: Nice. Share one quick productivity tip you like.",
      "You: I like batching messages and turning off notifications for 30 minutes to focus.",
      "Test Assistant: Last one—would you like me to summarize what you said as part of the test?",
      "You: Yes, please summarize it to confirm everything’s working.",
    ].join("\n")
  );
  const [readingMode, setReadingMode] = useState<boolean>(false);
  const [scriptFontSize, setScriptFontSize] = useState<number>(20);
  const [scrollSpeed, setScrollSpeed] = useState<number>(0); // pixels per second; 0 = manual
  const scriptContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!readingMode || scrollSpeed <= 0) return;
    const el = scriptContainerRef.current;
    if (!el) return;
    const intervalMs = 100; // update every 100ms
    const step = (scrollSpeed / 1000) * intervalMs; // px per tick
    const id = window.setInterval(() => {
      if (!scriptContainerRef.current) return;
      const c = scriptContainerRef.current;
      const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 2;
      if (atBottom) {
        window.clearInterval(id);
        return;
      }
      c.scrollTop = Math.min(c.scrollTop + step, c.scrollHeight);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [readingMode, scrollSpeed, scriptText]);
  // Auto-scroll captions to bottom when new items arrive (if user is near bottom)
  useEffect(() => {
    const el = captionsContainerRef.current;
    if (!el || !showCaptions) return;
    const delta = el.scrollHeight - el.scrollTop - el.clientHeight;
    // If within 80px of bottom, snap to bottom on new caption
    if (delta < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [captions.length, showCaptions]);

  // ---- Captions helpers ----
  const appendCaption = useCallback(
    (item: { speaker: "You" | "AI"; text: string }) => {
      const ts = Date.now();
      const id = `${item.speaker}-${ts}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const cleaned = item.text.trim();
      if (!cleaned) return;
      setCaptions((prev) => [
        ...prev,
        { id, speaker: item.speaker, text: cleaned, ts },
      ]);
    },
    []
  );

  // (Deprecated) MediaRecorder loop kept for reference only; replaced by VAD+WAV

  // WAV encoder (PCM16)
  const encodeWavPCM16 = useCallback(
    (samples: Float32Array, sampleRate: number) => {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++)
          view.setUint8(offset + i, str.charCodeAt(i));
      };
      // RIFF header
      writeString(0, "RIFF");
      view.setUint32(4, 36 + samples.length * 2, true);
      writeString(8, "WAVE");
      // fmt chunk
      writeString(12, "fmt ");
      view.setUint32(16, 16, true); // PCM
      view.setUint16(20, 1, true); // format: PCM
      view.setUint16(22, 1, true); // channels: mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true); // byte rate
      view.setUint16(32, 2, true); // block align
      view.setUint16(34, 16, true); // bits per sample
      // data chunk
      writeString(36, "data");
      view.setUint32(40, samples.length * 2, true);
      // PCM samples
      let offset = 44;
      for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([view], { type: "audio/wav" });
    },
    []
  );

  // VAD-based WAV transcriber
  const startVADTranscriber = useCallback(
    (stream: MediaStream, speaker: "You" | "AI") => {
      const isUser = speaker === "You";
      const activeRef = isUser ? userCaptionActiveRef : aiCaptionActiveRef;
      const cleanupRef = isUser ? userVADCleanupRef : aiVADCleanupRef;
      const busyRef = isUser ? userUploadBusyRef : aiUploadBusyRef;

      const W = window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const ACtor: typeof AudioContext =
        W.AudioContext || W.webkitAudioContext || AudioContext;
      const ctx = new ACtor();
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);

      const sr = ctx.sampleRate;
      const threshold = 0.015; // RMS threshold
      const hangoverMs = 300;
      const minVoiceMs = 400;
      const maxChunkMs = 4000;

      const buffer: Float32Array[] = [];
      let voiced = false;
      let lastVoiceTs = 0;
      // Track when a voiced segment starts (reserved for future UI/metrics)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      let chunkStartTs = 0;

      const nowMs = () => performance.now();
      const bufferedMs = () =>
        (buffer.reduce((sum, arr) => sum + arr.length, 0) / sr) * 1000;

      const flush = async () => {
        const totalLen = buffer.reduce((s, a) => s + a.length, 0);
        if (totalLen === 0) return;
        const total = new Float32Array(totalLen);
        let off = 0;
        for (const arr of buffer) {
          total.set(arr, off);
          off += arr.length;
        }
        buffer.length = 0;
        voiced = false;
        chunkStartTs = 0;

        // Skip too small
        if (total.length < sr * 0.25) return; // < 250ms

        // Encode WAV PCM16
        const wav = encodeWavPCM16(total, sr);
        if (wav.size < 8000) return;
        if (busyRef.current) return;
        busyRef.current = true;
        try {
          const fd = new FormData();
          const f = new File(
            [wav],
            `${speaker.toLowerCase()}-${Date.now()}.wav`,
            { type: "audio/wav" }
          );
          fd.append("file", f);
          fd.append("language", languageCode);
          const res = await fetch("/api/transcribe", {
            method: "POST",
            body: fd,
          });
          if (res.ok) {
            const data = (await res.json()) as { text?: string };
            if (data?.text) appendCaption({ speaker, text: data.text });
          }
        } catch {
          // ignore
        } finally {
          busyRef.current = false;
        }
      };

      processor.onaudioprocess = (ev) => {
        if (!activeRef.current) return;
        const input = ev.inputBuffer.getChannelData(0);
        // Copy to avoid reuse of underlying buffer
        const copy = new Float32Array(input.length);
        copy.set(input);
        // Compute RMS
        let sumsq = 0;
        for (let i = 0; i < copy.length; i++) {
          const v = copy[i];
          sumsq += v * v;
        }
        const rms = Math.sqrt(sumsq / copy.length);
        const t = nowMs();
        if (rms >= threshold) {
          lastVoiceTs = t;
          if (!voiced) {
            voiced = true;
            chunkStartTs = t; // tracked for potential future UI timing
          }
        }

        if (voiced) buffer.push(copy);

        const sinceVoice = t - lastVoiceTs;
        const dur = bufferedMs();
        if (
          voiced &&
          (dur >= maxChunkMs || (sinceVoice > hangoverMs && dur >= minVoiceMs))
        ) {
          // finish chunk
          void flush();
        }
      };

      source.connect(processor);
      processor.connect(ctx.destination); // necessary in some browsers to keep processor running

      activeRef.current = true;
      cleanupRef.current = () => {
        activeRef.current = false;
        try {
          source.disconnect();
        } catch {}
        try {
          processor.disconnect();
        } catch {}
        try {
          ctx.close();
        } catch {}
      };
    },
    [appendCaption, encodeWavPCM16, languageCode]
  );

  const buildFinalTranscript = useCallback(() => {
    const all = captions
      .sort((a, b) => a.ts - b.ts)
      .map((c) => {
        const d = new Date(c.ts);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        return `[${hh}:${mm}:${ss}] ${c.speaker}: ${c.text}`;
      })
      .join("\n");
    setTranscriptText(all);
  }, [captions]);

  // ---- Helpers ----
  const streamUser = useMemo(
    () => ({ id: userId, name: userName }),
    [userId, userName]
  );

  // Lightweight HS256 JWT signer using Web Crypto (avoids extra deps in POC)
  const makeStreamToken = useCallback(async (uid: string, secret: string) => {
    function base64url(input: ArrayBuffer | string) {
      const bytes =
        typeof input === "string"
          ? new TextEncoder().encode(input)
          : new Uint8Array(input);
      const base64 = btoa(String.fromCharCode(...Array.from(bytes)));
      return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }
    const header = { alg: "HS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = { user_id: uid, iat: now, exp: now + 30 * 60 };
    const encHeader = base64url(JSON.stringify(header));
    const encPayload = base64url(JSON.stringify(payload));
    const data = `${encHeader}.${encPayload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data)
    );
    const encSig = base64url(sig);
    return `${data}.${encSig}`;
  }, []);

  const joinStreamCall = useCallback(async () => {
    if (!apiKey) {
      alert("Missing Stream API key");
      return;
    }
    if (!apiSecret) {
      alert("Missing Stream API secret (POC only)");
      return;
    }
    // setJoining(true);
    try {
      const token = await makeStreamToken(streamUser.id, apiSecret);
      if (!token) throw new Error("Could not create POC token");

      const c = new StreamVideoClient({ apiKey, user: streamUser, token });
      setClient(c);

      const theCall = c.call("default", callId);
      setCall(theCall);

      await theCall.join({ create: true });
    } catch (e) {
      console.error(e);
      alert("Failed to join call. Check keys and try again.");
    } finally {
      // setJoining(false);
    }
  }, [apiKey, apiSecret, callId, makeStreamToken, streamUser]);

  const leaveStreamCall = useCallback(async () => {
    try {
      await (call as unknown as { leave?: () => Promise<void> })?.leave?.();
    } catch {}
    try {
      await client?.disconnectUser?.();
    } catch {}
    setCall(null);
    setClient(null);
  }, [call, client]);

  // ---- OpenAI Realtime (WebRTC) ----
  const startRealtime = useCallback(
    async (localAudioStream?: MediaStream) => {
      if (!openAIKey) {
        alert("Missing OpenAI API key");
        return;
      }
      setRtState("connecting");
      try {
        // Selection from UI
        const selectedVoice = voiceGender === "male" ? "ash" : "alloy";
        const langInstruction =
          language === "japanese" ? "Japanese" : "English";
        const questionBlock = questions
          .split(/\r?\n/)
          .filter((q) => q.trim().length > 0)
          .map((q, i) => `${i + 1}. ${q.trim()}`)
          .join(" ");

        // Prepare mic stream (reuse provided stream if available)
        let mic: MediaStream;
        if (localAudioStream) {
          mic = localAudioStream;
        } else {
          mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        micStreamRef.current = mic;

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
        });
        pcRef.current = pc;

        // Send mic, receive audio
        pc.addTransceiver("audio", { direction: "sendrecv" });
        mic.getTracks().forEach((t) => pc.addTrack(t, mic));

        // Optional: receive model-rendered video too (not used here)
        pc.addTransceiver("video", { direction: "recvonly" });

        // Remote audio playback
        const remoteStream = new MediaStream();
        remoteAudioStreamRef.current = remoteStream;
        pc.ontrack = (e) => {
          e.streams[0]?.getTracks().forEach((t) => remoteStream.addTrack(t));
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = remoteStream;
            remoteAudioRef.current.play().catch(() => {});
          }
          // If it's an audio track, and we have a mixer, add to mixed output
          const audioCtx = audioCtxRef.current;
          const audioDest = audioDestRef.current;
          const audioTracks = e.streams[0]?.getAudioTracks?.() || [];
          if (audioCtx && audioDest && audioTracks.length > 0) {
            const track = audioTracks[0];
            const node = audioCtx.createMediaStreamSource(
              new MediaStream([track])
            );
            node.connect(audioDest);
          }
          // Start AI captions transcriber once the remote audio stream becomes available
          const hasAudio = e.streams[0]?.getAudioTracks?.().length > 0;
          if (hasAudio && !aiCaptionActiveRef.current) {
            try {
              const aiOnlyStream = new MediaStream([
                e.streams[0].getAudioTracks()[0],
              ]);
              startVADTranscriber(aiOnlyStream, "AI");
            } catch {}
          }
        };

        // Control channel for events
        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;
        const computeDelayMs = () => {
          if (replyDelayMode === "random") {
            const min = Math.min(replyRandMinSec, replyRandMaxSec);
            const max = Math.max(replyRandMinSec, replyRandMaxSec);
            const sec = Math.floor(min + Math.random() * (max - min + 1));
            return sec * 1000;
          }
          return Math.max(0, replyFixedSec) * 1000;
        };
        const sendSessionUpdate = () => {
          const silence = computeDelayMs();
          dc.send(
            JSON.stringify({
              type: "session.update",
              session: {
                voice: selectedVoice,
                turn_detection: {
                  type: "server_vad",
                  silence_duration_ms: silence,
                },
                instructions:
                  `You should speak only in ${langInstruction}. ` +
                  `You are a friendly AI test assistant helping demo a voice and captions feature in an office environment. ` +
                  `Keep responses concise (1–2 sentences). Speak in a neutral, office-safe tone. ` +
                  `Ask one light question at a time about neutral topics (audio quality, productivity tips, current tasks). ` +
                  `Wait until the user finishes speaking before continuing. ` +
                  `If appropriate, mention this is a test of the voice and caption system. ` +
                  `The test prompts are: ${questionBlock}`,
              },
            })
          );
          return silence;
        };
        dc.onopen = () => {
          if (autoSpeak) {
            // Update session defaults to enforce voice + instructions + VAD silence duration
            sendSessionUpdate();
            // Then create the first audio response
            dc.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions:
                    `You should speak only in ${langInstruction}. ` +
                    "Start with a brief greeting that mentions we’re testing the voice and captions, then ask the first light, neutral question.",
                  modalities: ["audio", "text"],
                  conversation: "default",
                  audio: { voice: selectedVoice },
                },
              })
            );
          }
        };
        // Update VAD silence for next turns whenever a response completes (randomize if enabled)
        dc.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg?.type === "response.completed") {
              // For the next user turn, refresh turn_detection silence
              sendSessionUpdate();
            }
          } catch {}
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const baseUrl = "https://api.openai.com/v1/realtime";
        const model = "gpt-4o-realtime-preview-2024-12-17";
        const url = `${baseUrl}?model=${encodeURIComponent(
          model
        )}&voice=${encodeURIComponent(selectedVoice)}`;

        const sdpResponse = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openAIKey}`,
            "Content-Type": "application/sdp",
            "OpenAI-Beta": "realtime=v1",
          },
          body: offer.sdp || "",
        });
        const answerSdp = await sdpResponse.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

        setRtState("connected");
      } catch (e) {
        console.error("Realtime start failed", e);
        setRtState("disconnected");
        alert(
          "Failed to start OpenAI Realtime. Check key and browser permissions."
        );
      }
    },
    [
      autoSpeak,
      openAIKey,
      language,
      questions,
      replyDelayMode,
      replyFixedSec,
      replyRandMaxSec,
      replyRandMinSec,
      startVADTranscriber,
      voiceGender,
    ]
  );

  const stopRealtime = useCallback(() => {
    try {
      dcRef.current?.close();
    } catch {}
    try {
      pcRef.current?.getSenders().forEach((s) => s.track?.stop());
      pcRef.current?.close();
    } catch {}
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    pcRef.current = null;
    dcRef.current = null;
    setRtState("disconnected");
  }, []);

  // ---- Unified Start/Stop ----
  const startAll = useCallback(async () => {
    if (!apiKey || !apiSecret || !openAIKey) {
      alert(
        "Missing keys: ensure Stream API key/secret and OpenAI key are set."
      );
      return;
    }
    setSessionState("starting");
    try {
      // 1) Capture local A/V once
      const localAV = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      localAVRef.current = localAV;

      // 2) Start OpenAI Realtime using the local audio stream
      await startRealtime(
        new MediaStream([...(localAV.getAudioTracks() || [])])
      );

      // 3) Join Stream call
      await joinStreamCall();

      // 4) Setup audio mixing (mic + assistant) into one track
      type WinWithWebkit = typeof window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const w = window as WinWithWebkit;
      const Ctor: typeof AudioContext =
        w.AudioContext || w.webkitAudioContext || AudioContext;
      const audioCtx = new Ctor();
      audioCtxRef.current = audioCtx;
      const audioDest = audioCtx.createMediaStreamDestination();
      audioDestRef.current = audioDest;

      const micTracks = localAV.getAudioTracks();
      if (micTracks.length > 0) {
        const micNode = audioCtx.createMediaStreamSource(
          new MediaStream([micTracks[0]])
        );
        micNode.connect(audioDest);
      }
      // If assistant audio is already available, add it now (otherwise ontrack will add it later)
      const remote = remoteAudioStreamRef.current;
      if (remote && remote.getAudioTracks().length > 0) {
        const node = audioCtx.createMediaStreamSource(
          new MediaStream([remote.getAudioTracks()[0]])
        );
        node.connect(audioDest);
      }

      // 5) Compose output stream (local video + mixed audio)
      const out = new MediaStream();
      const videoTracks = localAV.getVideoTracks();
      if (videoTracks.length > 0) out.addTrack(videoTracks[0]);
      const mixedTrack = audioDest.stream.getAudioTracks()[0];
      if (mixedTrack) out.addTrack(mixedTrack);

      // 6) Start one MediaRecorder
      const rec = new MediaRecorder(out, {
        mimeType: "video/webm; codecs=vp9,opus",
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: "video/webm" });
          const ts = new Date();
          const fileName = `session-${ts.getFullYear()}${String(
            ts.getMonth() + 1
          ).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}-${String(
            ts.getHours()
          ).padStart(2, "0")}${String(ts.getMinutes()).padStart(
            2,
            "0"
          )}${String(ts.getSeconds()).padStart(2, "0")}.webm`;
          // Request a presigned URL then upload
          const presign = await fetch("/api/upload-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: fileName,
              contentType: blob.type,
            }),
          });
          if (!presign.ok) throw new Error("Failed to get upload URL");
          const { url, key, bucket } = await presign.json();
          const putRes = await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": blob.type },
            body: blob,
          });
          if (!putRes.ok) throw new Error("Upload failed");
          console.log("Uploaded to S3", { bucket, key });
        } catch (err) {
          console.error("Upload error", err);
          // Fallback: offer local download so the recording isn't lost
          try {
            const ts = new Date();
            const fallbackName = `session-${ts.getFullYear()}${String(
              ts.getMonth() + 1
            ).padStart(2, "0")}${String(ts.getDate()).padStart(
              2,
              "0"
            )}-${String(ts.getHours()).padStart(2, "0")}${String(
              ts.getMinutes()
            ).padStart(2, "0")}${String(ts.getSeconds()).padStart(
              2,
              "0"
            )}-local.webm`;
            const blob = new Blob(chunks, { type: "video/webm" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fallbackName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          } catch {}
          alert(
            "Upload to S3 failed. The recording was downloaded locally instead. For S3, check bucket CORS and server logs."
          );
        } finally {
          setSessionState("idle");
        }
      };
      mixedRecorderRef.current = rec;
      rec.start(250);

      // 7) Start user (mic) captions transcriber
      try {
        const micTracks2 = localAV.getAudioTracks();
        if (micTracks2.length > 0 && !userCaptionActiveRef.current) {
          const micOnly = new MediaStream([micTracks2[0]]);
          startVADTranscriber(micOnly, "You");
        }
      } catch {}

      setSessionState("running");
    } catch (e) {
      console.error("Failed to start session", e);
      setSessionState("idle");
      alert("Failed to start session. Check permissions and keys.");
    }
  }, [
    apiKey,
    apiSecret,
    joinStreamCall,
    openAIKey,
    startRealtime,
    startVADTranscriber,
  ]);

  const stopAll = useCallback(async () => {
    setSessionState("stopping");
    try {
      // Stop recorder (triggers auto-download in handler)
      mixedRecorderRef.current?.stop();
    } catch {}
    mixedRecorderRef.current = null;

    // Stop caption recorders
    try {
      userCaptionActiveRef.current = false;
      userCaptionRecRef.current?.stop();
    } catch {}
    userCaptionRecRef.current = null;
    try {
      aiCaptionActiveRef.current = false;
      aiCaptionRecRef.current?.stop();
    } catch {}
    aiCaptionRecRef.current = null;

    // Stop OpenAI Realtime
    try {
      stopRealtime();
    } catch {}

    // Leave Stream call
    try {
      await (call as unknown as { leave?: () => Promise<void> })?.leave?.();
      await client?.disconnectUser?.();
    } catch {}
    setCall(null);
    setClient(null);

    // Stop local AV
    try {
      localAVRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    localAVRef.current = null;

    // Close audio context
    try {
      await audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;
    audioDestRef.current = null;

    // If onstop didn't fire (no chunks), reset state anyway
    setTimeout(() => {
      if (sessionState !== "idle") setSessionState("idle");
      // Build final transcript when session ends
      buildFinalTranscript();
    }, 500);
  }, [buildFinalTranscript, call, client, sessionState, stopRealtime]);

  // ---- UI ----
  const InCallUI = () => {
    const { useLocalParticipant, useRemoteParticipants } = useCallStateHooks();
    const local = useLocalParticipant();
    const remotes = useRemoteParticipants();
    return (
      <div className="flex flex-col gap-3">
        <div className="flex gap-2 items-center">
          <button
            className="px-3 py-2 rounded bg-red-500 text-white"
            onClick={leaveStreamCall}
          >
            Leave call
          </button>
          <span className="text-sm text-gray-600">
            Local: {local?.userId ?? "-"} | Remotes: {remotes.length}
          </span>
        </div>
        <StreamTheme>
          <div className="border rounded overflow-hidden">
            <SpeakerLayout />
          </div>
          <div className="mt-2">
            <CallControls />
          </div>
        </StreamTheme>
      </div>
    );
  };

  return (
    <div className="p-4 flex flex-col gap-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold">
        Frontend-only POC: Stream Video + OpenAI Realtime
      </h1>

      {/* Minimal Controls */}
      <section className="border rounded p-3">
        <h2 className="text-lg font-medium mb-2">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">
              NEXT_PUBLIC_STREAM_API_KEY
            </span>
            <input
              className="border rounded px-2 py-1"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="stream api key"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">
              NEXT_PUBLIC_STREAM_API_SECRET (POC only)
            </span>
            <input
              className="border rounded px-2 py-1"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder="stream api secret"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">User ID</span>
            <input
              className="border rounded px-2 py-1"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">Call ID</span>
            <input
              className="border rounded px-2 py-1"
              value={callId}
              onChange={(e) => setCallId(e.target.value)}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-sm text-gray-600">
              NEXT_PUBLIC_OPENAI_API_KEY
            </span>
            <input
              className="border rounded px-2 py-1"
              value={openAIKey}
              onChange={(e) => setOpenAIKey(e.target.value)}
              placeholder="sk-..."
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(e) => setAutoSpeak(e.target.checked)}
            />
            <span className="text-sm">Auto-speak greeting</span>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">Voice gender</span>
            <select
              className="border rounded px-2 py-1"
              value={voiceGender}
              onChange={(e) =>
                setVoiceGender(e.target.value as "male" | "female")
              }
            >
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">Language</span>
            <select
              className="border rounded px-2 py-1"
              value={language}
              onChange={(e) =>
                setLanguage(e.target.value as "english" | "japanese")
              }
            >
              <option value="english">English</option>
              <option value="japanese">Japanese</option>
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">Reply timing</span>
            <div className="flex items-center gap-2">
              <select
                className="border rounded px-2 py-1"
                value={replyDelayMode}
                onChange={(e) =>
                  setReplyDelayMode(e.target.value as "fixed" | "random")
                }
              >
                <option value="fixed">Fixed delay</option>
                <option value="random">Random delay</option>
              </select>
              {replyDelayMode === "fixed" ? (
                <label className="flex items-center gap-2 text-sm">
                  <span>Seconds</span>
                  <input
                    type="number"
                    min={0}
                    max={15}
                    step={1}
                    className="border rounded px-2 py-1 w-20"
                    value={replyFixedSec}
                    onChange={(e) => setReplyFixedSec(Number(e.target.value))}
                  />
                </label>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <label className="flex items-center gap-1">
                    <span>Min</span>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      step={1}
                      className="border rounded px-2 py-1 w-16"
                      value={replyRandMinSec}
                      onChange={(e) =>
                        setReplyRandMinSec(Number(e.target.value))
                      }
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span>Max</span>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      step={1}
                      className="border rounded px-2 py-1 w-16"
                      value={replyRandMaxSec}
                      onChange={(e) =>
                        setReplyRandMaxSec(Number(e.target.value))
                      }
                    />
                  </label>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500">
              Controls how long the assistant waits after you stop speaking
              before replying.
            </p>
          </div>
        </div>
        <div className="mb-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">
              Interview questions (one per line)
            </span>
            <textarea
              className="border rounded px-2 py-1 min-h-32"
              value={questions}
              onChange={(e) => setQuestions(e.target.value)}
              placeholder={`Tell me about yourself.\nWhy are you interested in this role?`}
            />
          </label>
        </div>
        {/* Unified Start/Stop */}
        <div className="flex items-center gap-3 mt-2">
          {sessionState === "idle" || sessionState === "stopping" ? (
            <button
              className="px-4 py-2 rounded bg-emerald-600 text-white"
              onClick={startAll}
              disabled={sessionState === "stopping"}
            >
              {sessionState === "stopping" ? "Stopping…" : "Start session"}
            </button>
          ) : (
            <button
              className="px-4 py-2 rounded bg-red-600 text-white"
              onClick={stopAll}
              disabled={sessionState === "starting"}
            >
              {sessionState === "starting" ? "Starting…" : "Stop & save"}
            </button>
          )}
          <span className="text-sm text-gray-600">Assistant: {rtState}</span>
        </div>
        {/* Hidden audio element to play assistant's realtime audio */}
        <audio ref={remoteAudioRef} autoPlay />
        <p className="text-xs text-gray-500 mt-2">
          This POC runs entirely in the browser. Secrets in NEXT_PUBLIC_* are
          for testing only; do not use in production.
        </p>
      </section>

      {/* Call UI (shown when running) */}
      {client && call ? (
        <section className="border rounded p-3">
          <h2 className="text-lg font-medium mb-2">Call</h2>
          <div className="mt-2">
            <StreamVideo client={client}>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <StreamCall call={call as any}>
                <InCallUI />
              </StreamCall>
            </StreamVideo>
          </div>
        </section>
      ) : null}

      {/* Reading script */}
      <section className="border rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-medium">Reading script</h2>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={readingMode}
                onChange={(e) => setReadingMode(e.target.checked)}
              />
              Reading mode (auto-scroll)
            </label>
            <label className="flex items-center gap-2">
              Font
              <input
                type="range"
                min={14}
                max={36}
                value={scriptFontSize}
                onChange={(e) => setScriptFontSize(Number(e.target.value))}
              />
              <span>{scriptFontSize}px</span>
            </label>
            <label className="flex items-center gap-2">
              Scroll
              <input
                type="range"
                min={0}
                max={120}
                step={5}
                value={scrollSpeed}
                onChange={(e) => setScrollSpeed(Number(e.target.value))}
              />
              <span>{scrollSpeed}px/s</span>
            </label>
            <button
              className="px-2 py-1 border rounded"
              onClick={() => {
                setScriptText(
                  [
                    "Test Assistant: Hi there! We’re testing voice and live captions—when you’re ready, start reading this script.",
                    "You: Hey! I’m just running a quick test of the audio and transcription features.",
                    "Test Assistant: Great. How does the audio sound on your side?",
                    "You: It sounds clear enough for a demo in the office.",
                    "Test Assistant: Awesome. What are you working on right now?",
                    "You: I’m currently testing the live captions and making sure the UI updates smoothly.",
                    "Test Assistant: Nice. Share one quick productivity tip you like.",
                    "You: I like batching messages and turning off notifications for 30 minutes to focus.",
                    "Test Assistant: Last one—would you like me to summarize what you said as part of the test?",
                    "You: Yes, please summarize it to confirm everything’s working.",
                  ].join("\n")
                );
                // Snap to top for a fresh read
                setTimeout(() => {
                  if (scriptContainerRef.current) {
                    scriptContainerRef.current.scrollTop = 0;
                  }
                }, 0);
              }}
            >
              Load sample
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-2">
            <span className="text-sm text-gray-600">Your script</span>
            <textarea
              className="border rounded p-2 min-h-40"
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder={"Paste or write your script here..."}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-sm text-gray-600">Reader</span>
            <div
              ref={scriptContainerRef}
              className="border rounded p-3 h-60 overflow-auto bg-white"
              style={{ fontSize: `${scriptFontSize}px`, lineHeight: 1.5 }}
            >
              {scriptText.split(/\r?\n/).map((line, i) => (
                <p key={i} className="mb-2">
                  {line.trim().length === 0 ? <span>&nbsp;</span> : line}
                </p>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Live Captions */}
      <section className="border rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-medium">Live captions</h2>
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={showCaptions}
              onChange={(e) => setShowCaptions(e.target.checked)}
            />
            Show
          </label>
        </div>
        {showCaptions ? (
          <div
            ref={captionsContainerRef}
            className="border rounded p-2 h-48 overflow-auto bg-gray-50"
          >
            {captions.length === 0 ? (
              <p className="text-sm text-gray-500">No captions yet…</p>
            ) : (
              <ul className="space-y-1">
                {captions.slice(-100).map((c) => {
                  const d = new Date(c.ts);
                  const hh = String(d.getHours()).padStart(2, "0");
                  const mm = String(d.getMinutes()).padStart(2, "0");
                  const ss = String(d.getSeconds()).padStart(2, "0");
                  return (
                    <li key={c.id} className="text-sm">
                      <span className="text-gray-500 mr-2">
                        [{hh}:{mm}:{ss}]
                      </span>
                      <span
                        className={
                          c.speaker === "You"
                            ? "text-emerald-700"
                            : "text-indigo-700"
                        }
                      >
                        {c.speaker}:
                      </span>{" "}
                      <span>{c.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
        {transcriptText ? (
          <div className="mt-3">
            <h3 className="font-medium mb-1">Final transcript</h3>
            <textarea
              readOnly
              className="w-full border rounded p-2 text-sm h-40"
              value={transcriptText}
            />
            <div className="mt-2 flex gap-2">
              <button
                className="px-3 py-1 rounded bg-gray-800 text-white text-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(transcriptText);
                    alert("Transcript copied to clipboard");
                  } catch {}
                }}
              >
                Copy
              </button>
              <button
                className="px-3 py-1 rounded bg-gray-200 text-sm"
                onClick={() => {
                  const blob = new Blob([transcriptText], {
                    type: "text/plain",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  const ts = new Date();
                  a.download = `transcript-${ts
                    .toISOString()
                    .replace(/[:.]/g, "-")}.txt`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setTimeout(() => URL.revokeObjectURL(url), 5000);
                }}
              >
                Download
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
