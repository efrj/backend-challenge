import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { MetricsService } from "../../../infrastructure/observability/metrics.service";

@ApiTags("Observability")
@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metricsService: MetricsService,
  ) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @ApiOperation({ summary: "Expor métricas em formato Prometheus para scrape" })
  @ApiResponse({ status: 200, description: "Texto puro de métricas Prometheus" })
  getPrometheusMetrics(): string {
    return this.metricsService.toPrometheusText();
  }

  @Get("json")
  @ApiOperation({ summary: "Snapshot JSON das métricas internas e latências" })
  @ApiResponse({ status: 200, description: "Snapshot em JSON" })
  getJsonMetrics() {
    return this.metricsService.getSnapshot();
  }
}

