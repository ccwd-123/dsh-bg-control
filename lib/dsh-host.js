import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function candidateAnchors() {
  const list = [];
  if (process.env.DSH_INSTALL_ANCHOR && path.isAbsolute(process.env.DSH_INSTALL_ANCHOR)) {
    list.push(process.env.DSH_INSTALL_ANCHOR);
  }
  if (process.argv[1] && path.isAbsolute(process.argv[1])) {
    try {
      list.push(fs.realpathSync.native(process.argv[1]));
    } catch {
      list.push(process.argv[1]);
    }
  }
  const defaultWinAnchor = "D:\\Deepseek Harness\\resources\\app\\dsh\\package.json";
  if (fs.existsSync(defaultWinAnchor)) {
    list.push(defaultWinAnchor);
  }
  return list;
}

async function resolveHostModule(specifier) {
  try {
    return await import(specifier);
  } catch {}
  for (const anchor of candidateAnchors()) {
    try {
      const req = createRequire(anchor);
      const resolved = req.resolve(specifier);
      return await import(pathToFileURL(resolved).href);
    } catch {}
  }
  return null;
}

const schemasteryMod = await resolveHostModule("@deepseek-ai/schemastery");
const dshToolsMod = await resolveHostModule("@deepseek-ai/dsh-tools");

if (!schemasteryMod?.default) {
  throw new Error("Failed to resolve @deepseek-ai/schemastery from DSH host runtime.");
}
if (typeof dshToolsMod?.defineTool !== "function") {
  throw new Error("Failed to resolve defineTool from @deepseek-ai/dsh-tools in DSH host runtime.");
}

export const z = schemasteryMod.default;
export const defineTool = dshToolsMod.defineTool;
export const TOOL_ABORTED = dshToolsMod.TOOL_ABORTED;