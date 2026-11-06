import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { Observable, Subscription } from "rxjs";
import { isTelemetryStarted } from "../../../infrastructure/observability/telemetry";

interface HttpRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface HttpResponseLike {
  statusCode?: number;
}

/**
 * Creates one span per HTTP request when OpenTelemetry is enabled.
 * Financial amounts and payloads stay off the span.
 */
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(exec: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!isTelemetryStarted() || exec.getType() !== "http") {
      return next.handle();
    }

    const req = exec.switchToHttp().getRequest<HttpRequestLike>();
    const method = req.method ?? "UNKNOWN";
    const path = req.url?.split("?")[0] ?? "unknown";
    const correlationHeader = req.headers?.["x-correlation-id"];
    const correlationId = Array.isArray(correlationHeader)
      ? correlationHeader[0]
      : correlationHeader;

    const span = trace.getTracer("wagering-processor").startSpan(`HTTP ${method} ${path}`, {
      attributes: {
        "http.request.method": method,
        "url.path": path,
        ...(correlationId ? { "correlation.id": correlationId } : {}),
      },
    });

    return new Observable((subscriber) => {
      let inner: Subscription | undefined;
      context.with(trace.setSpan(context.active(), span), () => {
        inner = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err: unknown) => {
            span.setAttribute(
              "error.type",
              err instanceof Error ? err.name : "Error",
            );
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            subscriber.error(err);
          },
          complete: () => {
            const statusCode = exec
              .switchToHttp()
              .getResponse<HttpResponseLike>().statusCode;
            if (typeof statusCode === "number") {
              span.setAttribute("http.response.status_code", statusCode);
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            subscriber.complete();
          },
        });
      });

      return () => inner?.unsubscribe();
    });
  }
}
