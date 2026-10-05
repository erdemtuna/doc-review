import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const testRuntime = path.resolve(process.env.DOC_REVIEW_TEST_RUNTIME ??
  fileURLToPath(new URL("../../lib", import.meta.url)));
export const runtimeFile = name => path.join(testRuntime, ...name.split("/"));
export const runtimeImport = name => import(pathToFileURL(runtimeFile(name)).href);
