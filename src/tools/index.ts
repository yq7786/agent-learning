import {
  editFileTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "./file-tools.js";
import type { ToolDefinition } from "./registry.js";
import { globTool, grepTool } from "./search-tools.js";
import { bashTool } from "./shell-tools.js";
import {
  calculatorTool,
  startPreviewTool,
  weatherTool,
} from "./utility-tools.js";
import { pickSearchTool, webFetchTool } from "./web-search.js";

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  pickSearchTool(),
  webFetchTool,
  startPreviewTool,
];

export {
  bashTool,
  calculatorTool,
  editFileTool,
  globTool,
  grepTool,
  listDirectoryTool,
  readFileTool,
  weatherTool,
  writeFileTool,
};
