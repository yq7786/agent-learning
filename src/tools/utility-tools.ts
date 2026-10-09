import { existsSync, readFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import { extname, join, resolve } from "node:path";
import type { ToolDefinition } from "./registry";

let previewServer: Server | null = null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".tsx": "application/javascript; charset=utf-8",
  ".ts": "application/javascript; charset=utf-8",
  ".jsx": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

export const startPreviewTool: ToolDefinition = {
  name: "start_preview",
  description:
    "启动 app/ 目录的预览服务器，让浏览器能访问生成的网页应用。生成应用文件后必须立即调用此工具",
  parameters: {
    type: "object",
    properties: {
      port: { type: "number", description: "端口号，默认 8080" },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    const root = resolve("app");
    if (!existsSync(root))
      return "错误：app/ 目录不存在，请先用 write_file 生成应用文件";

    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split("?")[0] || "/").replace(
        /\/$/,
        "/index.html"
      );
      const filePath = join(root, urlPath === "/" ? "/index.html" : urlPath);
      try {
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        const content = readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type":
            MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    return new Promise<string>((resolve, reject) => {
      previewServer!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE")
          resolve(`端口 ${port} 已被占用，预览可能已经在跑了`);
        else reject(err);
      });
      previewServer!.listen(port, () => {
        resolve(
          `✓ 预览服务器已启动 → http://localhost:${port}（点击 Sandbox 的 Preview 标签查看）`
        );
      });
    });
  },
};

export const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "查询指定城市的天气信息",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "城市名称" } },
    required: ["city"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    const data: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
      广州: "多云转晴，20-28°C，东风 3 级",
      杭州: "晴，14-24°C，北风 2 级",
      成都: "阴，16-22°C，微风",
    };
    return data[city] || `${city}：暂无数据`;
  },
};

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "计算数学表达式的结果",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};
