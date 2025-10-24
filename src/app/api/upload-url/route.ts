import { NextRequest } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export async function POST(req: NextRequest) {
  try {
    const { filename, contentType } = await req.json();
    if (!filename || !contentType) {
      return new Response(
        JSON.stringify({ error: "filename and contentType are required" }),
        { status: 400 }
      );
    }

    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const bucket = process.env.S3_BUCKET;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!region || !bucket || !accessKeyId || !secretAccessKey) {
      return new Response(
        JSON.stringify({
          error:
            "Missing AWS env: AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY",
        }),
        { status: 500 }
      );
    }

    const client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });

    // Prefix with date to keep things tidy in the bucket
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const key = `${yyyy}/${mm}/${dd}/${filename}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(client, command, { expiresIn: 60 });

    return new Response(JSON.stringify({ url, key, bucket, region }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("/api/upload-url error", e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
