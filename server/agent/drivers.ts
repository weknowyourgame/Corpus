import type { AgentToolRegistry, ModelDriverFactory } from "./types.ts";
import { createGatewayDriverFactory, createPlannerDriverFactory } from "./gateway-driver.ts";

export function createModelDriverFactory(tools: AgentToolRegistry): ModelDriverFactory {
  const coderFactory = createGatewayDriverFactory(tools);
  return ({ tier, devModel }) => coderFactory({ tier, devModel });
}

export { createGatewayDriverFactory, createPlannerDriverFactory };
