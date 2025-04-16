import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  console.log("[Google Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  const bearToken =
    req.headers.get("x-goog-api-key") || req.headers.get("Authorization") || "";
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();

  const apiKey = token ? token : serverConfig.googleApiKey;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: true,
        message: `missing GOOGLE_API_KEY in server env vars`,
      },
      {
        status: 401,
      },
    );
  }
  try {
    const response = await request(req, apiKey);
    return response;
  } catch (e) {
    console.error("[Google] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
export const preferredRegion = [
  "bom1",
  "cle1",
  "cpt1",
  "gru1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
];

async function request(req: NextRequest, apiKey: string) {
  const isSSE = req?.nextUrl?.searchParams?.get("alt") === "sse";

  if (isSSE) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // 构造心跳消息
    const heartbeatMessage = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: "思考中...",
              },
            ],
            role: "model",
          },
          index: 0,
          safetyRatings: [
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              probability: "NEGLIGIBLE",
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              probability: "NEGLIGIBLE",
            },
            {
              category: "HARM_CATEGORY_HARASSMENT",
              probability: "NEGLIGIBLE",
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              probability: "NEGLIGIBLE",
            },
          ],
        },
      ],
    };

    let count = 0;
    const maxCount = 300;

    const sendMessage = async () => {
      if (count >= maxCount) {
        writer.close();
        return;
      }

      try {
        await writer.write(
          new TextEncoder().encode(
            `data: ${JSON.stringify(heartbeatMessage)}\n\n`,
          ),
        );
        count++;
        console.log(`Sent message ${count} at:`, Date.now());
        setTimeout(sendMessage, 1000);
      } catch (e) {
        console.error("Write error:", e);
        writer.close();
      }
    };

    // 开始发送消息
    sendMessage();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // 非 SSE 请求返回空响应
  return new Response(null, { status: 200 });
}
