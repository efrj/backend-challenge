import { EntityManager } from "@mikro-orm/postgresql";
import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { SqsService } from "../../../infrastructure/messaging/sqs.service";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsService) private readonly sqsService: SqsService,
  ) {}

  @Get("live")
  live() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
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
