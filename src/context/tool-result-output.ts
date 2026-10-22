import type { ToolResultPart } from "ai";

export type ToolResultOutput = ToolResultPart["output"];

/*
  普通文字 → 工具结果对象
  textToolResultOutput("文件读取成功");
  {
    type: "text",
    value: "文件读取成功"
  }
*/
export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: "text", value };
}

/*
  做相反方向的工作：工具结果对象 → 普通文字
*/
export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      // 直接取出文字
      return output.value;
    case "json":
    case "error-json":
    /*
      是把对象、数组等数据转换成文字
      输入：
      {
        type: "json",
        value: { count: 3 }
      }
      输出的字符串内容：
      {"count":3}
    */
      return JSON.stringify(output.value);
    case "content":
    /*
      对于由多个片段组成的结果：
        - 遇到文字片段，就取出文字。
        - 遇到其他片段，就写一个媒体标记，例如 [media: image/png]。
        - 最后用 join("\n") 把各段连起来，每段之间换一行。
      它不会识别图片里的内容，只保留一个“这里有媒体”的标记。
    */
      return output.value
        .map((part) =>
          part.type === "text" ? part.text : `[media: ${part.mediaType}]`
        )
        .join("\n");
  }
}
