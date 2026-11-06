import { EntityManager } from "@mikro-orm/postgresql";
import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { SqsService } from "../../../infrastructure/messaging/sqs.service";

@ApiTags("Observability")
@Controller("health")
export class HealthController {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsService) private readonly sqsService: SqsService,
  ) {}

  @Get("live")
  @ApiOperation({ summary: "Liveness probe: indica se o processo está ativo" })
  @ApiResponse({ status: 200, description: "Processo saudável" })
  live() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness probe: valida conectividade com PostgreSQL e SQS" })
  @ApiResponse({ status: 200, description: "Todos os serviços dependentes acessíveis" })
  @ApiResponse({ status: 503, description: "PostgreSQL ou SQS indisponíveis" })
  async ready(@Res() res: Response) {
    let postgresReachable = false;
    try {
      await this.em.getConnection().execute("SELECT 1");
      postgresReachable = true;
    } catch {
      postgresReachable = false;
    }

    const sqsReachable = await this.sqsService.isHealthy();
    const isReady = postgresReachable && sqsReachable;

    res
      .status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        status: isReady ? "ready" : "degraded",
        checks: {
          postgres: postgresReachable ? "up" : "down",
          sqs: sqsReachable ? "up" : "down",
        },
        timestamp: new Date().toISOString(),
      });
  }
}
