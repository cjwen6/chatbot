import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
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
  const controller = new AbortController();

  const isSSE = req?.nextUrl?.searchParams?.get("alt") === "sse";

  let baseUrl = serverConfig.googleUrl || GEMINI_BASE_URL;
  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Google, "");

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  const fetchUrl = `${baseUrl}${path}${isSSE ? "?alt=sse" : ""}`;

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key":
        req.headers.get("x-goog-api-key") ||
        (req.headers.get("Authorization") ?? "").replace("Bearer ", ""),
    },
    method: req.method,
    body: req.body,
    redirect: "manual",
    duplex: "half",
    signal: controller.signal,
  };

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

    // 发送初始心跳
    writer.write(
      new TextEncoder().encode(`data: ${JSON.stringify(heartbeatMessage)}\n\n`),
    );

    // 设置定期心跳
    const heartbeat = setInterval(() => {
      writer.write(
        new TextEncoder().encode(
          `data: ${JSON.stringify(heartbeatMessage)}\n\n`,
        ),
      );
    }, 5000);

    // 异步处理实际请求
    fetch(fetchUrl, fetchOptions)
      .then(async (res) => {
        if (!res.ok) {
          clearInterval(heartbeat);
          const errorData = await res.text();
          writer.write(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ error: errorData })}\n\n`,
            ),
          );
          writer.close();
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          clearInterval(heartbeat);
          writer.close();
          return;
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            clearInterval(heartbeat); // 收到第一个响应后停止心跳
            await writer.write(value);
          }
        } catch (e) {
          console.error("Stream error:", e);
        } finally {
          clearInterval(heartbeat);
          writer.close();
          reader.releaseLock();
        }
      })
      .catch((e) => {
        clearInterval(heartbeat);
        writer.write(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ error: e.message })}\n\n`,
          ),
        );
        writer.close();
      });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // 非 SSE 请求保持原有逻辑
  const res = await fetch(fetchUrl, fetchOptions);
  const newHeaders = new Headers(res.headers);
  newHeaders.delete("www-authenticate");
  newHeaders.set("X-Accel-Buffering", "no");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}
