// Next.js calls this for every unhandled server error (pages, server actions, API routes).
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportError } = await import("./lib/monitoring");
  reportError(err, {
    path: request.path.split("?")[0], // no query string: it can hold tokens
    method: request.method,
    routeType: context.routeType,
    route: context.routePath,
    digest: (err as { digest?: string }).digest,
  });
};
