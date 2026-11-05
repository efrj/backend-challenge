import { Controller, Get, Header, Inject } from "@nestjs/common";
import { MetricsService } from "../../../infrastructure/observability/metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metricsService: MetricsService,
  ) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  getPrometheusMetrics(): string {
    return this.metricsService.toPrometheusText();
  }

  @Get("json")
  getJsonMetrics() {
    return this.metricsService.getSnapshot();
  }
}

