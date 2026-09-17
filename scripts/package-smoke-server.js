import { pathToFileURL } from "node:url";

const { start } = await import(pathToFileURL(process.argv[2]).href);
const review = await start();
process.send({ port: review.port, token: review.token });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await review.dispose();
  if (process.connected) process.disconnect();
}
process.once("message", stop);
process.once("disconnect", stop);
process.once("SIGTERM", stop);
