import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { getAppConfig } from "../config/app-config";
import { StructuredLoggerService } from "../observability/structured-logger.service";

@Injectable()
export class DatabaseMigratorService implements OnModuleInit {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!getAppConfig().autoMigrate) {
      return;
    }
    await this.migrateUp();
  }

  async migrateUp(): Promise<void> {
    const migrator = this.orm.getMigrator();
    const executed = await migrator.up();
    if (executed.length > 0) {
      this.logger.info("Database migrations applied", {
        migrations: executed.map((m) => m.name),
      });
    }
  }

  async migrateDown(): Promise<void> {
    const migrator = this.orm.getMigrator();
    await migrator.down();
  }
}

