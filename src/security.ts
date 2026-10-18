import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";

export function createApiSecurity() {
  const token = randomBytes(32).toString("hex");
  function authorize(req: Request, port: number) {
    const host = `127.0.0.1:${port}`, origin = `http://${host}`;
    const supplied = req.headers.get("x-ticketpipe-token") ?? "";
    if (req.headers.get("host") !== host || new URL(req.url).origin !== origin || (req.headers.has("origin") && req.headers.get("origin") !== origin) || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new AppError("This local control request is not authorized.", 403);
  }
  return { token, authorize };
}
