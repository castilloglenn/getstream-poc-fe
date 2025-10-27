export const runtime = "nodejs";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const language = (form.get("language") as string) || "";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    // Drop tiny chunks to avoid 400s from Whisper like "no speech" / invalid audio
    if ((file as File).size < 8000) {
      return NextResponse.json({ text: "" }, { status: 200 });
    }

    const apiKey =
      process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server missing OPENAI_API_KEY" },
        { status: 500 }
      );
    }

    const model = (process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1").trim();
    const fd = new FormData();
    // Pass through the file; name must be provided for OpenAI to accept
    fd.append("file", file, (file as File).name || "audio.webm");
    fd.append("model", model);
    if (language) fd.append("language", language);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: fd,
    });

    if (!res.ok) {
      const errText = await res.text();
      const lowered = errText.toLowerCase();
      if (
        res.status === 400 ||
        lowered.includes("no speech") ||
        lowered.includes("could not decode audio") ||
        lowered.includes("invalid") ||
        lowered.includes("too short")
      ) {
        console.warn("Whisper 400/short/invalid chunk ignored", {
          status: res.status,
          errText,
        });
        return NextResponse.json({ text: "" }, { status: 200 });
      }
      console.error("Whisper error", { status: res.status, errText });
      return NextResponse.json({ text: "" }, { status: 200 });
    }

    const data = await res.json();
    return NextResponse.json({ text: data.text ?? "" });
  } catch {
    // Treat unexpected errors as empty to avoid noisy 5xx in the client POC
    return NextResponse.json({ text: "" }, { status: 200 });
  }
}
