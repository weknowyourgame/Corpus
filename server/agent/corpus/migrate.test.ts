// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildMigrationCommand, schemaPath } from "./migrate.ts";

describe("corpus migration command", () => {
  it("points psql at the corpus schema with stop-on-error enabled", () => {
    const command = buildMigrationCommand("postgres://example");

    expect(command.command).toBe("psql");
    expect(command.args).toEqual([
      "postgres://example",
      "--file",
      schemaPath,
      "--set",
      "ON_ERROR_STOP=1",
    ]);
  });
});
