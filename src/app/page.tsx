"use client";

import { useCallback, useMemo, useRef, useState } from "react";
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
  const [userId, setUserId] = useState(
    "user-" + Math.random().toString(36).slice(2, 8)
  );
  const [userName] = useState("Demo User");
  const [callId, setCallId] = useState("poc-call");
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
  const [questions, setQuestions] = useState(
    [
      "Tell me about yourself.",
      "Why are you interested in this role?",
      "Describe a challenging project and your impact.",
      "What are your strengths and areas for growth?",
      "Do you have any questions for us?",
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
        const selectedVoice = voiceGender === "male" ? "alloy" : "verse";
        const langInstruction =
          language === "japanese" ? "Speak Japanese." : "Speak English.";
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
        };

        // Control channel for events
        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;
        dc.onopen = () => {
          if (autoSpeak) {
            // Update session defaults to enforce voice + instructions
            dc.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  voice: selectedVoice,
                  instructions: `You are an HR interviewer. ${langInstruction} Ask questions one by one, allow time for spoken answers, and provide brief follow-ups when helpful. Only proceed to the next question after the candidate stops speaking. The interview questions are: ${questionBlock}`,
                },
              })
            );
            // Then create the first audio response
            dc.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions:
                    "Start with a short greeting, then ask the first interview question.",
                  modalities: ["audio"],
                  conversation: "default",
                  audio: { voice: selectedVoice },
                },
              })
            );
          }
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
    [autoSpeak, openAIKey, language, questions, voiceGender]
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
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        // Auto-download
        const ts = new Date();
        const name = `session-${ts.getFullYear()}${String(
          ts.getMonth() + 1
        ).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}-${String(
          ts.getHours()
        ).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(
          ts.getSeconds()
        ).padStart(2, "0")}.webm`;
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setSessionState("idle");
      };
      mixedRecorderRef.current = rec;
      rec.start(250);

      setSessionState("running");
    } catch (e) {
      console.error("Failed to start session", e);
      setSessionState("idle");
      alert("Failed to start session. Check permissions and keys.");
    }
  }, [apiKey, apiSecret, joinStreamCall, openAIKey, startRealtime]);

  const stopAll = useCallback(async () => {
    setSessionState("stopping");
    try {
      // Stop recorder (triggers auto-download in handler)
      mixedRecorderRef.current?.stop();
    } catch {}
    mixedRecorderRef.current = null;

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
    }, 500);
  }, [call, client, sessionState, stopRealtime]);

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
    </div>
  );
}
