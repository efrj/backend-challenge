import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmOptions } from "./mikro-orm.config";

async function run() {
  const direction = process.argv[2] ?? "up";
  const orm = await MikroORM.init(createMikroOrmOptions());
  try {
    const migrator = orm.getMigrator();
    if (direction === "down") {
      const res = await migrator.down();
      console.log(
        JSON.stringify({
          event: "migration.down",
          reverted: res.map((m) => m.name),
        }),
      );
    } else {
      const res = await migrator.up();
      console.log(
        JSON.stringify({
          event: "migration.up",
          applied: res.map((m) => m.name),
        }),
      );
    }
  } finally {
    await orm.close(true);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

